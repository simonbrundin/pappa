package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"reflect"
	"strings"
	"sync"
	"time"

	"mailagent/actions"
	"mailagent/ai"
	"mailagent/config"
	"mailagent/imap"
	"mailagent/rules"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Server wraps the MCP server with mail agent dependencies
type Server struct {
	cfg        *config.Config
	aiProvider *ai.OpenAIProvider
	executor   *actions.Executor
	imapClient *imap.Client
	account    *config.MailAccount
	httpServer *http.Server

	// sessions keeps one IMAP session per account, so that switching accounts
	// in the UI does not require a new login every time.
	sessions *sessionStore

	// connMu serialises switching the active account and connection.
	connMu sync.Mutex

	// logins holds the pending device code logins per account.
	loginsMu sync.Mutex
	logins   map[string]*pendingLogin

	// analyses holds the AI proposals for the emails the user has analysed,
	// so that an approval can be executed with the exact proposed arguments.
	analysesMu sync.Mutex
	analyses   map[string]map[uint32]analysisItem

	// rulesMu protects the rules, which can be replaced at runtime when
	// someone edits them in the web UI.
	rulesMu sync.RWMutex
	// rulesPath is the file the rules are read from and written to.
	rulesPath string
	// rulesContent is the full markdown of the rules file, as read at
	// startup or as last saved through the API.
	rulesContent string
	// ruleSet is the parsed version of rulesContent.
	ruleSet *rules.RuleSet
}

// NewServer creates a new MCP server.
//
// rulesPath and rulesContent describe the rules file the server serves and
// saves. rulesContent may be empty, in which case the file is read from
// rulesPath when the rules are first needed.
func NewServer(cfg *config.Config, aiProv *ai.OpenAIProvider, ruleSet *rules.RuleSet, rulesPath, rulesContent string) *Server {
	return &Server{
		cfg:          cfg,
		aiProvider:   aiProv,
		ruleSet:      ruleSet,
		rulesPath:    rulesPath,
		rulesContent: rulesContent,
		sessions:     newSessionStore(),
		logins:       make(map[string]*pendingLogin),
		analyses:     make(map[string]map[uint32]analysisItem),
	}
}

// currentRuleSet returns the rules the AI should follow right now.
func (s *Server) currentRuleSet() *rules.RuleSet {
	s.rulesMu.RLock()
	defer s.rulesMu.RUnlock()
	return s.ruleSet
}

// analysisKey identifies the analyses for one account and folder.
func analysisKey(account, folder string) string {
	return account + "|" + folder
}

// storeAnalyses saves the analyses for an account and folder.
func (s *Server) storeAnalyses(account, folder string, items map[uint32]analysisItem) {
	s.analysesMu.Lock()
	defer s.analysesMu.Unlock()
	s.analyses[analysisKey(account, folder)] = items
}

// analysisFor returns a previously stored analysis.
func (s *Server) analysisFor(account, folder string, uid uint32) (analysisItem, bool) {
	s.analysesMu.Lock()
	defer s.analysesMu.Unlock()
	item, ok := s.analyses[analysisKey(account, folder)][uid]
	return item, ok
}

// Start begins the MCP server on stdio
func (s *Server) Start(ctx context.Context) error {
	server := s.newMCPServer()
	return server.Run(ctx, &mcp.StdioTransport{})
}

// newMCPServer creates a new MCP server with tools configured
func (s *Server) newMCPServer() *mcp.Server {
	server := mcp.NewServer(
		&mcp.Implementation{Name: "mailagent", Version: "1.0.0"},
		&mcp.ServerOptions{Instructions: "MailAgent - Email processing with AI"},
	)
	s.addTools(server)
	return server
}

// StartHTTP starts the MCP server with HTTP endpoints
func (s *Server) StartHTTP(ctx context.Context, addr string) error {
	server := s.newMCPServer()

	// Create HTTP handler for MCP protocol
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server {
		return server
	}, nil)

	// Create mux to handle both MCP protocol and our custom HTTP endpoints
	mux := http.NewServeMux()
	mux.Handle("/mcp", handler)
	mux.Handle("/api/mcp", handler)

	// Add custom HTTP endpoints (UI API + MCP endpoints)
	httpHandler := s.HTTPHandler()
	mux.HandleFunc("/", httpHandler.ServeHTTP)

	s.httpServer = &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	log.Printf("MCP HTTP server starting on %s", addr)
	return s.httpServer.ListenAndServe()
}

// Shutdown stops the HTTP server
func (s *Server) Shutdown(ctx context.Context) error {
	if s.httpServer != nil {
		return s.httpServer.Shutdown(ctx)
	}
	return nil
}

// --- Connection Management ---

// ensureConnection connects to the default account.
func (s *Server) ensureConnection() (*accountSession, error) {
	return s.ensureConnectionFor("")
}

// ensureConnectionFor makes sure an IMAP connection exists for the given
// account name. An empty name means the first configured account. The
// connection is cached per account, so switching back and forth is cheap.
func (s *Server) ensureConnectionFor(accountName string) (*accountSession, error) {
	s.connMu.Lock()
	defer s.connMu.Unlock()

	account, err := s.accountByName(accountName)
	if err != nil {
		return nil, err
	}

	// Reuse the session from an earlier visit to this account, unless its
	// connection died.
	if session, ok := s.sessions.get(account.Name); ok && !session.broken {
		return session, nil
	}
	s.sessions.remove(account.Name)

	credential, err := credentialFor(account)
	if err != nil {
		return nil, fmt.Errorf("failed to get credentials for account %q: %w", account.Name, err)
	}

	client, err := imap.NewClient(account)
	if err != nil {
		return nil, fmt.Errorf("failed to create IMAP client for account %q: %w", account.Name, err)
	}
	if err := client.Connect(credential); err != nil {
		return nil, fmt.Errorf("failed to connect to account %q: %w", account.Name, err)
	}

	session := &accountSession{
		account:    account,
		imapClient: client,
		credential: credential,
	}
	s.sessions.put(account.Name, session)

	return session, nil
}

// activeSession returns the session used when no account is specified.
func (s *Server) activeSession() *accountSession {
	s.connMu.Lock()
	defer s.connMu.Unlock()
	if session, ok := s.sessions.get(s.defaultAccountName()); ok {
		return session
	}
	return nil
}

// defaultAccountName returns the name of the first configured account.
func (s *Server) defaultAccountName() string {
	if s.cfg == nil || len(s.cfg.Mail) == 0 {
		return ""
	}
	return s.cfg.Mail[0].Name
}

// resolveFolder returns the folder to use. When no folder is given, the
// folder configured for the account is used.
func (s *Server) resolveFolder(account *config.MailAccount, folder string) string {
	if folder != "" {
		return folder
	}
	if account != nil && account.Folder != "" {
		return account.Folder
	}
	return "INBOX"
}

// --- Tool Definitions ---

// toolDefinition describes one MCP tool. It is kept separate from mcp.Tool so
// the tool list can be built (and tested) without a live server.
type toolDefinition struct {
	Name        string
	Description string
}

// toolDefinitions returns the tools the server exposes, with the configured
// account names written into the descriptions. An agent can then see which
// accounts exist without calling list_accounts first.
func (s *Server) toolDefinitions() []toolDefinition {
	accountHint := s.accountHint()

	return []toolDefinition{
		{
			Name:        "list_accounts",
			Description: "List the configured mail accounts, with username, folder and login state." + accountHint,
		},
		{
			Name:        "list_emails",
			Description: "List emails in a folder. Returns email subjects, senders, and UIDs." + accountHint,
		},
		{
			Name:        "read_email",
			Description: "Read the full content of an email including body." + accountHint,
		},
		{
			Name:        "archive_email",
			Description: "Archive an email." + accountHint,
		},
		{
			Name:        "reply_to_email",
			Description: "Reply to an email." + accountHint,
		},
		{
			Name:        "forward_email",
			Description: "Forward an email to another email address. Requires 'to' parameter." + accountHint,
		},
		{
			Name:        "move_email",
			Description: "Move an email to a different folder." + accountHint,
		},
		{
			Name:        "process_emails_with_ai",
			Description: "Process emails using AI to decide and execute actions." + accountHint,
		},
	}
}

// toolInputSchemas returns the JSON schema of each tool's arguments. The
// schema is inferred the same way the MCP server infers it, so the tests see
// exactly what an agent sees.
func (s *Server) toolInputSchemas() map[string]*jsonschema.Schema {
	schemas := make(map[string]*jsonschema.Schema)

	for _, entry := range []struct {
		name   string
		params any
	}{
		{"list_accounts", ListAccountsParams{}},
		{"list_emails", ListEmailsParams{}},
		{"read_email", ReadEmailParams{}},
		{"archive_email", ArchiveEmailParams{}},
		{"reply_to_email", ReplyToEmailParams{}},
		{"forward_email", ForwardEmailParams{}},
		{"move_email", MoveEmailParams{}},
		{"process_emails_with_ai", ProcessEmailsParams{}},
	} {
		schema, err := jsonschema.ForType(reflect.TypeOf(entry.params), &jsonschema.ForOptions{})
		if err != nil {
			continue
		}
		schemas[entry.name] = schema
	}

	return schemas
}

// accountHint describes the account parameter and the accounts that exist.
// Every tool takes an optional "account" - an empty value means the default
// account (the first configured one).
func (s *Server) accountHint() string {
	accounts := s.accountNames()

	switch len(accounts) {
	case 0:
		return " No accounts are configured."
	case 1:
		return " Optional 'account' picks the account; empty means the default one. Accounts: " + accounts[0] + "."
	default:
		return " Optional 'account' picks the account; empty means the default one. Accounts: " + strings.Join(accounts, ", ") + "."
	}
}

// accountNames returns the names of the configured accounts.
func (s *Server) accountNames() []string {
	if s.cfg == nil {
		return nil
	}
	names := make([]string, 0, len(s.cfg.Mail))
	for i := range s.cfg.Mail {
		names = append(names, s.cfg.Mail[i].Name)
	}
	return names
}

func (s *Server) addTools(server *mcp.Server) {
	for _, tool := range s.toolDefinitions() {
		switch tool.Name {
		case "list_accounts":
			mcp.AddTool(server, &mcp.Tool{Name: tool.Name, Description: tool.Description}, s.toolListAccounts)
		case "list_emails":
			mcp.AddTool(server, &mcp.Tool{Name: tool.Name, Description: tool.Description}, s.toolListEmails)
		case "read_email":
			mcp.AddTool(server, &mcp.Tool{Name: tool.Name, Description: tool.Description}, s.toolReadEmail)
		case "archive_email":
			mcp.AddTool(server, &mcp.Tool{Name: tool.Name, Description: tool.Description}, s.toolArchiveEmail)
		case "reply_to_email":
			mcp.AddTool(server, &mcp.Tool{Name: tool.Name, Description: tool.Description}, s.toolReplyToEmail)
		case "forward_email":
			mcp.AddTool(server, &mcp.Tool{Name: tool.Name, Description: tool.Description}, s.toolForwardEmail)
		case "move_email":
			mcp.AddTool(server, &mcp.Tool{Name: tool.Name, Description: tool.Description}, s.toolMoveEmail)
		case "process_emails_with_ai":
			mcp.AddTool(server, &mcp.Tool{Name: tool.Name, Description: tool.Description}, s.toolProcessEmailsWithAI)
		}
	}
}

// ListAccountsParams has no parameters - list_accounts lists everything.
type ListAccountsParams struct{}

// toolListAccounts lists the configured accounts with their login state, so an
// agent can pick which one to work with.
func (s *Server) toolListAccounts(ctx context.Context, req *mcp.CallToolRequest, args ListAccountsParams) (*mcp.CallToolResult, any, error) {
	accounts := make([]AccountInfo, 0, len(s.accountNames()))
	for i := range s.cfg.Mail {
		accounts = append(accounts, s.accountInfo(&s.cfg.Mail[i]))
	}

	payload, err := json.MarshalIndent(map[string]interface{}{"accounts": accounts}, "", "  ")
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: string(payload)}},
	}, nil, nil
}

type ListEmailsParams struct {
	// Account väljer vilket konto som läses. Tomt = första kontot.
	Account string `json:"account,omitempty"`
	Folder  string `json:"folder,omitempty"`
	Limit   int    `json:"limit,omitempty"`
}

func (s *Server) toolListEmails(ctx context.Context, req *mcp.CallToolRequest, args ListEmailsParams) (*mcp.CallToolResult, any, error) {
	session, err := s.ensureConnectionFor(args.Account)
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	folder := s.resolveFolder(session.account, args.Folder)
	limit := args.Limit
	if limit == 0 {
		limit = 10
	}

	emails, err := session.imapClient.ListEmails(folder, uint32(limit))
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	var result string
	for _, email := range emails {
		result += fmt.Sprintf("- #%d: %s (from: %s)\n", email.UID, email.Subject, email.From)
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("Found %d emails in %s:\n%s", len(emails), folder, result)}},
	}, nil, nil
}

type ReadEmailParams struct {
	// Account väljer vilket konto som läses. Tomt = första kontot.
	Account string `json:"account,omitempty"`
	Folder  string `json:"folder,omitempty"`
	UID     int    `json:"uid"`
}

func (s *Server) toolReadEmail(ctx context.Context, req *mcp.CallToolRequest, args ReadEmailParams) (*mcp.CallToolResult, any, error) {
	session, err := s.ensureConnectionFor(args.Account)
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	if args.UID == 0 {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: uid is required"}},
			IsError: true,
		}, nil, nil
	}

	folder := s.resolveFolder(session.account, args.Folder)

	email, err := session.imapClient.ReadEmail(folder, uint32(args.UID))
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	text := fmt.Sprintf("From: %s\nTo: %s\nDate: %s\nSubject: %s\n\n%s",
		email.From, email.To, email.Date.Format(time.RFC3339), email.Subject, email.Body)

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
	}, nil, nil
}

type ArchiveEmailParams struct {
	// Account väljer vilket konto som läses. Tomt = första kontot.
	Account string `json:"account,omitempty"`
	Folder  string `json:"folder,omitempty"`
	UID     int    `json:"uid"`
}

func (s *Server) toolArchiveEmail(ctx context.Context, req *mcp.CallToolRequest, args ArchiveEmailParams) (*mcp.CallToolResult, any, error) {
	session, err := s.ensureConnectionFor(args.Account)
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	if args.UID == 0 {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: uid is required"}},
			IsError: true,
		}, nil, nil
	}

	folder := s.resolveFolder(session.account, args.Folder)

	if err := session.imapClient.ArchiveEmail(folder, uint32(args.UID)); err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("Email %d archived", args.UID)}},
	}, nil, nil
}

type ReplyToEmailParams struct {
	// Account väljer vilket konto som läses. Tomt = första kontot.
	Account string `json:"account,omitempty"`
	Folder  string `json:"folder,omitempty"`
	UID     int    `json:"uid"`
	Message string `json:"message"`
}

func (s *Server) toolReplyToEmail(ctx context.Context, req *mcp.CallToolRequest, args ReplyToEmailParams) (*mcp.CallToolResult, any, error) {
	session, err := s.ensureConnectionFor(args.Account)
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	if args.UID == 0 {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: uid is required"}},
			IsError: true,
		}, nil, nil
	}

	folder := s.resolveFolder(session.account, args.Folder)

	email, err := session.imapClient.ReadEmail(folder, uint32(args.UID))
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	ruleResp := &rules.Response{
		Action:     "reply",
		Motivation: "",
		ActionArgs: map[string]interface{}{"reply": args.Message},
	}

	if err := session.executor.Execute(email, ruleResp); err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("Replied to email %d", args.UID)}},
	}, nil, nil
}

type ForwardEmailParams struct {
	// Account väljer vilket konto som läses. Tomt = första kontot.
	Account string `json:"account,omitempty"`
	Folder  string `json:"folder,omitempty"`
	UID     int    `json:"uid"`
	To      string `json:"to"`
	Note    string `json:"note"`
}

func (s *Server) toolForwardEmail(ctx context.Context, req *mcp.CallToolRequest, args ForwardEmailParams) (*mcp.CallToolResult, any, error) {
	session, err := s.ensureConnectionFor(args.Account)
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	if args.UID == 0 {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: uid is required"}},
			IsError: true,
		}, nil, nil
	}
	if args.To == "" {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: 'to' address is required"}},
			IsError: true,
		}, nil, nil
	}

	folder := s.resolveFolder(session.account, args.Folder)

	email, err := session.imapClient.ReadEmail(folder, uint32(args.UID))
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	note := args.Note
	if note == "" {
		note = "Forwarded email"
	}

	ruleResp := &rules.Response{
		Action:     "forward",
		Motivation: "",
		ActionArgs: map[string]interface{}{"to": args.To, "reply": note},
	}

	if err := session.executor.Execute(email, ruleResp); err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("Email %d forwarded to %s", args.UID, args.To)}},
	}, nil, nil
}

type MoveEmailParams struct {
	// Account väljer vilket konto som läses. Tomt = första kontot.
	Account     string `json:"account,omitempty"`
	Folder      string `json:"folder,omitempty"`
	UID         int    `json:"uid"`
	Destination string `json:"destination"`
}

func (s *Server) toolMoveEmail(ctx context.Context, req *mcp.CallToolRequest, args MoveEmailParams) (*mcp.CallToolResult, any, error) {
	session, err := s.ensureConnectionFor(args.Account)
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	if args.UID == 0 {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: uid is required"}},
			IsError: true,
		}, nil, nil
	}
	if args.Destination == "" {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: 'destination' is required"}},
			IsError: true,
		}, nil, nil
	}

	folder := s.resolveFolder(session.account, args.Folder)

	if err := session.imapClient.MoveEmail(folder, args.Destination, uint32(args.UID)); err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: fmt.Sprintf("Email %d moved to %s", args.UID, args.Destination)}},
	}, nil, nil
}

type ProcessEmailsParams struct {
	// Account väljer vilket konto som läses. Tomt = första kontot.
	Account string `json:"account,omitempty"`
	Folder  string `json:"folder,omitempty"`
	Limit   int    `json:"limit,omitempty"`
}

func (s *Server) toolProcessEmailsWithAI(ctx context.Context, req *mcp.CallToolRequest, args ProcessEmailsParams) (*mcp.CallToolResult, any, error) {
	session, err := s.ensureConnectionFor(args.Account)
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	folder := s.resolveFolder(session.account, args.Folder)
	limit := args.Limit
	if limit == 0 {
		limit = 10
	}

	emails, err := session.imapClient.ListEmails(folder, uint32(limit))
	if err != nil {
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
			IsError: true,
		}, nil, nil
	}

	var results string
	for _, email := range emails {
		fullEmail, err := session.imapClient.ReadEmail(folder, email.UID)
		if err != nil {
			results += fmt.Sprintf("❌ #%d: Error reading - %v\n", email.UID, err)
			continue
		}

		ruleSet := s.currentRuleSet()
		if ruleSet == nil {
			return &mcp.CallToolResult{
				Content: []mcp.Content{&mcp.TextContent{Text: "Error: rules not configured"}},
				IsError: true,
			}, nil, nil
		}

		aiResp, err := s.aiProvider.Process(ctx, ruleSet.BuildPromptForAI(fullEmail))
		if err != nil {
			results += fmt.Sprintf("❌ #%d (%s): AI error - %v\n", email.UID, email.Subject, err)
			continue
		}

		ruleResp := &rules.Response{
			Action:     aiResp.Action,
			Motivation: aiResp.Motivation,
			ActionArgs: aiResp.ActionArgs,
		}

		if err := session.executor.Execute(fullEmail, ruleResp); err != nil {
			results += fmt.Sprintf("⚠️ #%d (%s): %s - %v\n", email.UID, email.Subject, aiResp.Action, err)
		} else {
			results += fmt.Sprintf("✅ #%d (%s): %s\n", email.UID, email.Subject, aiResp.Action)
		}
	}

	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: results}},
	}, nil, nil
}
