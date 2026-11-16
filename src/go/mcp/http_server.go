package mcp

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"mailagent/config"
	"mailagent/rules"
)

// withCORS allows the Nuxt dev server (different port => different origin)
// to call the API from the browser.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Vary", "Origin")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// HTTPHandler creates an HTTP handler for the MCP server
func (s *Server) HTTPHandler() http.Handler {
	return withCORS(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Printf("[MCP HTTP] %s %s\n", r.Method, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		path := r.URL.Path

		// MCP protocol endpoints
		if path == "/mcp" || path == "/api/mcp" || path == "/tools/list" {
			s.httpMCPToolList(w, r)
			return
		}

		// API v1 endpoints for UI
		switch {
		// List accounts: GET /api/v1/accounts
		case r.Method == "GET" && (path == "/api/v1/accounts" || path == "/api/v1/accounts/"):
			s.httpListAccounts(w, r)

		// List folders of an account: GET /api/v1/accounts/{account}/folders
		case r.Method == "GET" && strings.Contains(path, "/accounts/") && strings.HasSuffix(path, "/folders"):
			s.httpAccountFolders(w, r, path)

		// Start a login: POST /api/v1/accounts/{account}/auth/login
		case r.Method == "POST" && strings.Contains(path, "/accounts/") && strings.HasSuffix(path, "/auth/login"):
			s.httpStartAccountLogin(w, r, path)

		// Poll a login: GET /api/v1/accounts/{account}/auth/status
		case r.Method == "GET" && strings.Contains(path, "/accounts/") && strings.HasSuffix(path, "/auth/status"):
			s.httpAccountLoginStatus(w, r, path)

		// List emails: GET /api/v1/accounts/{account}/folders/{folder}/emails
		case r.Method == "GET" && strings.Contains(path, "/accounts/") && strings.Contains(path, "/folders/") && strings.HasSuffix(path, "/emails"):
			s.httpListEmails(w, r, path)

		// Read one email: GET /api/v1/accounts/{account}/folders/{folder}/emails/{uid}
		case r.Method == "GET" && strings.Contains(path, "/accounts/") && strings.Contains(path, "/folders/") && strings.Contains(path, "/emails/"):
			s.httpReadEmail(w, r, path)

		// Archive one email: POST /api/v1/accounts/{account}/folders/{folder}/emails/{uid}/archive
		case r.Method == "POST" && strings.Contains(path, "/accounts/") && strings.Contains(path, "/folders/") && strings.Contains(path, "/emails/") && strings.HasSuffix(path, "/archive"):
			s.httpArchiveEmail(w, r, path)

		// Process: POST /api/v1/accounts/{account}/process
		case r.Method == "POST" && strings.Contains(path, "/accounts/") && strings.HasSuffix(path, "/process"):
			s.httpProcessEmails(w, r, path)

		// Analyse without executing: POST /api/v1/accounts/{account}/analyze
		case r.Method == "POST" && strings.Contains(path, "/accounts/") && strings.HasSuffix(path, "/analyze"):
			s.httpAnalyzeEmails(w, r, path)

		// Approve or deny a proposed action: POST /api/v1/accounts/{account}/decision
		case r.Method == "POST" && strings.Contains(path, "/accounts/") && strings.HasSuffix(path, "/decision"):
			s.httpDecideEmail(w, r, path)

		// Rules: GET/PUT /api/v1/rules
		case r.Method == "GET" && (path == "/api/v1/rules" || path == "/rules"):
			s.httpGetRules(w, r)
		case r.Method == "PUT" && (path == "/api/v1/rules" || path == "/rules"):
			s.httpUpdateRules(w, r)

		// Health
		case path == "/health":
			json.NewEncoder(w).Encode(map[string]string{"status": "ok"})

		default:
			fmt.Printf("[MCP HTTP] No handler for %s %s\n", r.Method, path)
			http.Error(w, `{"error": "Not found"}`, http.StatusNotFound)
		}
	}))
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeAccountError writes an error that came from an account operation. It
// picks the status code from the error message, so the client can tell an
// unknown account (404) from an account that needs a login (401) from a real
// server error (500).
func writeAccountError(w http.ResponseWriter, err error) {
	writeError(w, accountErrorStatus(err), err.Error())
}

// accountErrorStatus maps an account error to an HTTP status code.
func accountErrorStatus(err error) int {
	if err == nil {
		return 500
	}
	message := err.Error()
	switch {
	case strings.Contains(message, "unknown account"):
		return 404
	case strings.Contains(message, "not logged in"),
		strings.Contains(message, "no cached OAuth token"),
		strings.Contains(message, "login failed"),
		strings.Contains(message, "login required"):
		return 401
	default:
		return 500
	}
}

// --- MCP Tool List ---

func (s *Server) httpMCPToolList(w http.ResponseWriter, r *http.Request) {
	tools := make([]map[string]interface{}, 0, len(s.toolDefinitions()))
	for _, tool := range s.toolDefinitions() {
		tools = append(tools, map[string]interface{}{
			"name":        tool.Name,
			"description": tool.Description,
		})
	}
	writeJSON(w, 200, map[string]interface{}{"tools": tools})
}

// --- HTTP API Handlers ---

func (s *Server) httpListEmails(w http.ResponseWriter, r *http.Request, path string) {
	// Parse: /api/v1/accounts/{account}/folders/{folder}/emails
	account := ""
	folder := "INBOX"
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if p == "accounts" && i+1 < len(parts) {
			account = parts[i+1]
		}
		if p == "folders" && i+1 < len(parts) {
			folder = parts[i+1]
			break
		}
	}

	// Override from query param
	if f := r.URL.Query().Get("folder"); f != "" {
		folder = f
	}

	session, err := s.ensureConnectionFor(account)
	if err != nil {
		writeAccountError(w, err)
		return
	}

	limit := uint32(50)
	if l := r.URL.Query().Get("limit"); l != "" {
		fmt.Sscanf(l, "%d", &limit)
	}

	emails, err := s.listEmails(session, folder, limit)
	if err != nil {
		writeAccountError(w, err)
		return
	}

	result := make([]map[string]interface{}, 0, len(emails))
	for _, e := range emails {
		mailFolder := e.Folder
		if mailFolder == "" {
			mailFolder = folder
		}
		result = append(result, map[string]interface{}{
			"uid":            e.UID,
			"subject":        e.Subject,
			"from":           e.From,
			"date":           e.Date,
			"folder":         mailFolder,
			"has_attachment": e.HasAttachment,
		})
	}

	writeJSON(w, 200, map[string]interface{}{"emails": result})
}

// emailTarget parses account, folder and uid out of a path on the form
// /api/v1/accounts/{account}/folders/{folder}/emails/{uid}[/archive].
func emailTarget(path string) (account string, folder string, uid uint32, ok bool) {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if p == "accounts" && i+1 < len(parts) {
			account = parts[i+1]
		}
		if p == "folders" && i+1 < len(parts) {
			folder = parts[i+1]
		}
		if p == "emails" && i+1 < len(parts) {
			parsed, err := strconv.ParseUint(parts[i+1], 10, 32)
			if err != nil {
				return "", "", 0, false
			}
			uid = uint32(parsed)
			return account, folder, uid, true
		}
	}
	return "", "", 0, false
}

// httpReadEmail returns the full content of one email.
func (s *Server) httpReadEmail(w http.ResponseWriter, r *http.Request, path string) {
	account, folder, uid, ok := emailTarget(path)
	if !ok {
		writeError(w, 400, "invalid email path, expected .../emails/{uid}")
		return
	}

	session, err := s.ensureConnectionFor(account)
	if err != nil {
		writeAccountError(w, err)
		return
	}

	if folder == "" {
		folder = s.defaultFolder(session.account)
	}

	email, err := session.imapClient.ReadEmail(folder, uid)
	if err != nil {
		writeAccountError(w, err)
		return
	}

	writeJSON(w, 200, map[string]interface{}{
		"uid":            email.UID,
		"subject":        email.Subject,
		"from":           email.From,
		"to":             email.To,
		"date":           email.Date,
		"folder":         folder,
		"body":           email.Body,
		"has_attachment": email.HasAttachment,
	})
}

// httpArchiveEmail moves one email to the archive folder.
func (s *Server) httpArchiveEmail(w http.ResponseWriter, r *http.Request, path string) {
	account, folder, uid, ok := emailTarget(path)
	if !ok {
		writeError(w, 400, "invalid email path, expected .../emails/{uid}/archive")
		return
	}

	session, err := s.ensureConnectionFor(account)
	if err != nil {
		writeAccountError(w, err)
		return
	}

	if folder == "" {
		folder = s.defaultFolder(session.account)
	}

	if err := session.imapClient.ArchiveEmail(folder, uid); err != nil {
		writeAccountError(w, err)
		return
	}

	writeJSON(w, 200, map[string]interface{}{
		"uid":      uid,
		"folder":   folder,
		"archived": true,
	})
}

// httpProcessEmails runs the AI over the emails in a folder and executes the
// resulting actions (reply/archive/forward/read/move).
func (s *Server) httpProcessEmails(w http.ResponseWriter, r *http.Request, path string) {
	account := ""
	parts := strings.Split(path, "/")
	for i, p := range parts {
		if p == "accounts" && i+1 < len(parts) {
			account = parts[i+1]
			break
		}
	}

	var req struct {
		Folder string `json:"folder"`
		Limit  int    `json:"limit"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		writeError(w, 400, err.Error())
		return
	}

	session, err := s.ensureConnectionFor(account)
	if err != nil {
		writeAccountError(w, err)
		return
	}

	folder := req.Folder
	if folder == "" {
		folder = s.defaultFolder(session.account)
	}
	limit := req.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}

	ruleSet := s.currentRuleSet()
	if s.aiProvider == nil || ruleSet == nil {
		writeError(w, 500, "AI provider or rules not configured")
		return
	}

	emails, err := s.listEmails(session, folder, uint32(limit))
	if err != nil {
		writeAccountError(w, err)
		return
	}

	results := make([]map[string]interface{}, 0, len(emails))
	for _, e := range emails {
		result := map[string]interface{}{
			"uid":        e.UID,
			"subject":    e.Subject,
			"action":     "uncertain",
			"confidence": 0,
			"motivation": "",
			"success":    false,
		}

		full, err := session.imapClient.ReadEmail(folder, e.UID)
		if err != nil {
			result["error"] = fmt.Sprintf("kunde inte läsa mailet: %v", err)
			results = append(results, result)
			continue
		}

		aiResp, err := s.aiProvider.Process(r.Context(), ruleSet.BuildPromptForAI(full))
		if err != nil {
			result["error"] = fmt.Sprintf("AI-fel: %v", err)
			results = append(results, result)
			continue
		}

		result["action"] = aiResp.Action
		result["confidence"] = fmt.Sprintf("%.0f%%", aiResp.Confidence*100)
		result["motivation"] = aiResp.Motivation

		ruleResp := &rules.Response{
			Action:     aiResp.Action,
			Motivation: aiResp.Motivation,
			Confidence: aiResp.Confidence,
			ActionArgs: aiResp.ActionArgs,
		}
		if err := session.executor.Execute(full, ruleResp); err != nil {
			result["error"] = err.Error()
		} else if aiResp.Action == "uncertain" || aiResp.Action == "skip" || aiResp.Action == "" {
			result["success"] = false
			result["error"] = "ingen regel matchade - ingen åtgärd utfördes"
		} else {
			result["success"] = true
		}

		results = append(results, result)
	}

	writeJSON(w, 200, map[string]interface{}{"results": results})
}

// defaultFolder returns the configured folder for an account.
func (s *Server) defaultFolder(account *config.MailAccount) string {
	if account != nil && account.Folder != "" {
		return account.Folder
	}
	return "INBOX"
}
