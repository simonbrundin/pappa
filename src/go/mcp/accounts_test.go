package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ToolAccountParams tests that the account parameter reaches the tool.
func TestToolListAccountsListsConfiguredAccounts(t *testing.T) {
	s := testServer(t)

	result, _, err := s.toolListAccounts(context.Background(), nil, ListAccountsParams{})
	if err != nil {
		t.Fatalf("toolListAccounts: %v", err)
	}

	text := toolText(t, result)
	for _, want := range []string{"Michael Brundins", "Soulmate", "michael@brundins.se"} {
		if !strings.Contains(text, want) {
			t.Errorf("expected the output to mention %q, got %q", want, text)
		}
	}
}

// TestToolListEmailsUsesTheChosenAccount checks that the account parameter
// selects which mailbox the tool talks to.
func TestToolListEmailsUsesTheChosenAccount(t *testing.T) {
	t.Setenv("TEST_MAIL_PASSWORD_MICHAEL", "secret")

	s := testServer(t)

	// The accounts point at an unreachable server, so the tool fails. The
	// error still has to name the account that was asked for - that is what
	// proves the parameter was used.
	result, _, err := s.toolListEmails(context.Background(), nil, ListEmailsParams{Account: "Soulmate"})
	if err != nil {
		t.Fatalf("toolListEmails: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected the tool to report an error")
	}
	if !strings.Contains(toolText(t, result), "Soulmate") {
		t.Errorf("expected the error to name the account, got %q", toolText(t, result))
	}
}

// TestToolListEmailsRejectsUnknownAccount checks that a bad account name is
// reported instead of silently falling back to the first account.
func TestToolListEmailsRejectsUnknownAccount(t *testing.T) {
	s := testServer(t)

	result, _, err := s.toolListEmails(context.Background(), nil, ListEmailsParams{Account: "Borta"})
	if err != nil {
		t.Fatalf("toolListEmails: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected an error for an unknown account")
	}
	if !strings.Contains(toolText(t, result), "Borta") {
		t.Errorf("expected the error to name the missing account, got %q", toolText(t, result))
	}
}

// TestToolSchemasExposeAccountParameter checks that the account parameter is
// visible to the agent, so it can discover how to pick an account.
func TestToolSchemasExposeAccountParameter(t *testing.T) {
	s := testServer(t)

	tools := s.toolDefinitions()

	for _, tool := range tools {
		if tool.Name == "list_accounts" {
			continue
		}
		if !strings.Contains(tool.Description, "account") {
			t.Errorf("tool %q does not mention the account parameter", tool.Name)
		}
	}
}

// TestToolDefinitionsIncludeListAccounts checks that the account list is
// reachable as a tool.
func TestToolDefinitionsIncludeListAccounts(t *testing.T) {
	s := testServer(t)

	names := make(map[string]bool)
	for _, tool := range s.toolDefinitions() {
		names[tool.Name] = true
	}

	for _, want := range []string{"list_accounts", "list_emails", "read_email"} {
		if !names[want] {
			t.Errorf("expected the tool %q to be registered", want)
		}
	}
}

// toolText extracts the text content of a tool result.
func toolText(t *testing.T, result *mcp.CallToolResult) string {
	t.Helper()

	var sb strings.Builder
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			sb.WriteString(text.Text)
		}
	}
	return sb.String()
}

// TestToolListAccountsReturnsJSON checks that the account list is machine
// readable, so an agent can parse it.
func TestToolListAccountsReturnsJSON(t *testing.T) {
	s := testServer(t)

	result, _, err := s.toolListAccounts(context.Background(), nil, ListAccountsParams{})
	if err != nil {
		t.Fatalf("toolListAccounts: %v", err)
	}

	var payload struct {
		Accounts []AccountInfo `json:"accounts"`
	}
	if err := json.Unmarshal([]byte(toolText(t, result)), &payload); err != nil {
		t.Fatalf("the output is not valid JSON: %v", err)
	}
	if len(payload.Accounts) != 2 {
		t.Fatalf("expected 2 accounts, got %d", len(payload.Accounts))
	}
}

// TestToolSchemasDoNotRequireOptionalArguments checks that arguments with a
// default value are not marked as required in the schema. If they are, an
// agent has to invent values for them - it cannot call list_emails with just
// an account name.
func TestToolSchemasDoNotRequireOptionalArguments(t *testing.T) {
	s := testServer(t)

	schemas := s.toolInputSchemas()

	for _, tool := range []struct {
		name       string
		notAllowed []string
	}{
		{"list_emails", []string{"folder", "limit", "account"}},
		{"read_email", []string{"folder", "account"}},
		{"archive_email", []string{"folder", "account"}},
		{"reply_to_email", []string{"folder", "account"}},
		{"forward_email", []string{"folder", "account"}},
		{"move_email", []string{"folder", "account"}},
		{"process_emails_with_ai", []string{"folder", "limit", "account"}},
	} {
		schema, ok := schemas[tool.name]
		if !ok {
			t.Errorf("no schema for the tool %q", tool.name)
			continue
		}
		for _, arg := range tool.notAllowed {
			for _, required := range schema.Required {
				if required == arg {
					t.Errorf("tool %q marks %q as required, but it has a default", tool.name, arg)
				}
			}
		}
	}
}

// TestAccountErrorStatus checks that account errors get a status code that
// describes what went wrong. A client must be able to tell an unknown
// account from an account that needs a login.
func TestAccountErrorStatus(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
	}{
		{"okänt konto", errors.New(`unknown account "Borta"`), 404},
		{"inte inloggad", errors.New("failed to get credentials for account \"Soulmate\": account is not logged in: no cached OAuth token"), 401},
		{"ogiltig inloggning", errors.New(`failed to connect to account "Michael Brundins": login failed: Authentication failed.`), 401},
		{"annat fel", errors.New("something else went wrong"), 500},
	}

	for _, c := range cases {
		if got := accountErrorStatus(c.err); got != c.status {
			t.Errorf("%s: expected status %d, got %d", c.name, c.status, got)
		}
	}
}
