package mcp

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mailagent/config"
	"mailagent/rules"
)

const sampleRules = `# AI-mejlhanterare - Regler

## Regler

### Regeln: Viktigt

Villkor: Ämnet innehåller "viktigt"

Åtgärd:

1. Svara med: "Hanteras!"
2. Arkivera mejlet
`

// newRulesServer creates a server whose rules live in a temporary file.
func newRulesServer(t *testing.T, content string) (*Server, string) {
	t.Helper()

	path := filepath.Join(t.TempDir(), "rules.md")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("kunde inte skriva regelfil: %v", err)
	}

	ruleSet, err := rules.ParseMarkdown(content)
	if err != nil {
		t.Fatalf("kunde inte tolka reglerna: %v", err)
	}

	server := NewServer(&config.Config{}, nil, ruleSet, path, content)
	return server, path
}

func TestGetRulesReturnsTheRulesFile(t *testing.T) {
	server, _ := newRulesServer(t, sampleRules)

	rec := httptest.NewRecorder()
	server.HTTPHandler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/v1/rules", nil))

	if rec.Code != 200 {
		t.Fatalf("ville ha 200, fick %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Regeln: Viktigt") {
		t.Errorf("svaret saknar regeltexten: %s", rec.Body.String())
	}
}

func TestUpdateRulesWritesTheFileAndSwapsInTheNewRules(t *testing.T) {
	server, path := newRulesServer(t, sampleRules)

	updated := strings.Replace(sampleRules, "Regeln: Viktigt", "Regeln: Obehövligt", 1)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/v1/rules", strings.NewReader(rulesBody(updated)))
	server.HTTPHandler().ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("ville ha 200, fick %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"success":true`) {
		t.Errorf("svaret ska vara success: %s", rec.Body.String())
	}

	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("kunde inte läsa regelfilen: %v", err)
	}
	if string(onDisk) != updated {
		t.Errorf("regelfilen på disk har inte uppdaterats:\n%s", onDisk)
	}

	ruleSet := server.currentRuleSet()
	if ruleSet == nil || len(ruleSet.Rules) != 1 {
		t.Fatalf("regeluppsättningen har inte bytts ut: %+v", ruleSet)
	}
	if ruleSet.Rules[0].Name != "Obehövligt" {
		t.Errorf("regeln heter %q, vill ha Obehövligt", ruleSet.Rules[0].Name)
	}
}

func TestUpdateRulesRejectsEmptyAndRuleLessContent(t *testing.T) {
	server, _ := newRulesServer(t, sampleRules)

	for name, body := range map[string]string{
		"tomt":       `{"content":"   "}`,
		"utan regel": `{"content":"# Bara en rubrik\n\nIngen regel här."}`,
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("PUT", "/api/v1/rules", strings.NewReader(body))
		server.HTTPHandler().ServeHTTP(rec, req)

		if rec.Code != 400 {
			t.Errorf("%s: ville ha 400, fick %d: %s", name, rec.Code, rec.Body.String())
		}
	}
}

// rulesBody builds the JSON body of a rules update.
func rulesBody(content string) string {
	body, err := json.Marshal(map[string]string{"content": content})
	if err != nil {
		panic(err)
	}
	return string(body)
}
