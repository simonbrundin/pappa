package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"mailagent/rules"
)

// httpGetRules returns the rules as markdown, so the web UI can show them
// and let the user edit them.
func (s *Server) httpGetRules(w http.ResponseWriter, r *http.Request) {
	content, err := s.currentRulesContent()
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}

	s.rulesMu.RLock()
	ruleSet := s.ruleSet
	s.rulesMu.RUnlock()

	rulesCount := 0
	if ruleSet != nil {
		rulesCount = len(ruleSet.Rules)
	}

	writeJSON(w, 200, map[string]interface{}{
		"content":    content,
		"rulesCount": rulesCount,
	})
}

// httpUpdateRules saves new rules. The markdown is parsed first, so a broken
// document is rejected instead of silently replacing the working rules.
func (s *Server) httpUpdateRules(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, 400, err.Error())
		return
	}

	content := req.Content
	if strings.TrimSpace(content) == "" {
		writeError(w, 400, "reglerna kan inte vara tomma")
		return
	}

	ruleSet, err := rules.ParseMarkdown(content)
	if err != nil {
		writeError(w, 400, fmt.Sprintf("reglerna kunde inte tolkas: %v", err))
		return
	}
	if len(ruleSet.Rules) == 0 {
		writeError(w, 400, "inga regler hittades - varje regel behöver en rubrik som '### Regeln: Namn'")
		return
	}

	if err := s.saveRules(content, ruleSet); err != nil {
		writeError(w, 500, err.Error())
		return
	}

	fmt.Printf("[MCP HTTP] Rules updated: %d chars, %d rules\n", len(content), len(ruleSet.Rules))

	writeJSON(w, 200, map[string]interface{}{
		"success":    true,
		"message":    fmt.Sprintf("Regler sparade (%d regler)", len(ruleSet.Rules)),
		"rulesCount": len(ruleSet.Rules),
	})
}

// currentRulesContent returns the rules as markdown. The file on disk wins,
// so rules edited outside the web UI are picked up as well. If the file
// cannot be read, the content from startup is used.
func (s *Server) currentRulesContent() (string, error) {
	s.rulesMu.RLock()
	path := s.rulesPath
	content := s.rulesContent
	s.rulesMu.RUnlock()

	if path == "" {
		if content == "" {
			return "", fmt.Errorf("inga regler är inlästa")
		}
		return content, nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if content != "" {
			return content, nil
		}
		return "", fmt.Errorf("kunde inte läsa regelfilen %s: %w", path, err)
	}

	return string(data), nil
}

// saveRules writes the rules to disk and swaps in the parsed version, so the
// AI uses the new rules immediately.
func (s *Server) saveRules(content string, ruleSet *rules.RuleSet) error {
	s.rulesMu.RLock()
	path := s.rulesPath
	s.rulesMu.RUnlock()

	if path == "" {
		return fmt.Errorf("regler kan inte sparas - ingen regelfil är satt")
	}

	if err := writeFileAtomic(path, content); err != nil {
		return fmt.Errorf("kunde inte spara regelfilen %s: %w", path, err)
	}

	s.rulesMu.Lock()
	s.rulesContent = content
	s.ruleSet = ruleSet
	s.rulesMu.Unlock()

	return nil
}

// writeFileAtomic writes data to path via a temporary file in the same
// directory, then renames it. A crash mid-write therefore cannot leave a
// half-written rules file behind.
func writeFileAtomic(path, data string) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()

	if _, err := tmp.WriteString(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		os.Remove(tmpName)
		return err
	}

	return os.Rename(tmpName, path)
}
