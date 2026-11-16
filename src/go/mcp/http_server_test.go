package mcp

import "testing"

// TestEmailTargetParsesPath checks that account, folder and uid are read out
// of the path used by the read and archive endpoints.
func TestEmailTargetParsesPath(t *testing.T) {
	cases := []struct {
		name        string
		path        string
		wantAccount string
		wantFolder  string
		wantUID     uint32
		wantOK      bool
	}{
		{
			name:        "läser ett mejl",
			path:        "/api/v1/accounts/Michael Brundins/folders/INBOX/emails/42",
			wantAccount: "Michael Brundins",
			wantFolder:  "INBOX",
			wantUID:     42,
			wantOK:      true,
		},
		{
			name:        "läser ett mejl i en mapp med specialtecken",
			path:        "/api/v1/accounts/Michael Brundins/folders/INBOX.Kameo.Stängnäs 4246/emails/7",
			wantAccount: "Michael Brundins",
			wantFolder:  "INBOX.Kameo.Stängnäs 4246",
			wantUID:     7,
			wantOK:      true,
		},
		{
			name:        "arkiverar ett mejl",
			path:        "/api/v1/accounts/Michael Brundins/folders/INBOX/emails/42/archive",
			wantAccount: "Michael Brundins",
			wantFolder:  "INBOX",
			wantUID:     42,
			wantOK:      true,
		},
		{
			name:   "saknar uid",
			path:   "/api/v1/accounts/Michael Brundins/folders/INBOX/emails",
			wantOK: false,
		},
		{
			name:   "uid är inte ett tal",
			path:   "/api/v1/accounts/Michael Brundins/folders/INBOX/emails/abc",
			wantOK: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			account, folder, uid, ok := emailTarget(tc.path)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !tc.wantOK {
				return
			}
			if account != tc.wantAccount {
				t.Errorf("account = %q, want %q", account, tc.wantAccount)
			}
			if folder != tc.wantFolder {
				t.Errorf("folder = %q, want %q", folder, tc.wantFolder)
			}
			if uid != tc.wantUID {
				t.Errorf("uid = %d, want %d", uid, tc.wantUID)
			}
		})
	}
}
