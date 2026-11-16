package imap

import (
	"testing"

	"golang.org/x/text/unicode/norm"

	"mailagent/config"
)

// accountForTest returns an account pointing at one.com.
func accountForTest() *config.MailAccount {
	return &config.MailAccount{
		Name:     "Michael Brundins",
		Server:   "imap.one.com",
		Port:     993,
		Username: "michael@brundins.se",
		Folder:   "INBOX",
		UseTLS:   true,
	}
}

// TestFolderNamesAreNFD checks that folder names are normalised to NFD before
// they are sent to the server.
//
// one.com stores mailbox names in decomposed form ("A" + U+030A instead of
// U+00C5). Without the normalisation the server answers "Mailbox doesn't
// exist" for every folder with a Swedish character in its name.
func TestFolderNamesAreNFD(t *testing.T) {
	client := &Client{cfg: accountForTest()}

	got := client.getFolderName("INBOX.Kameo.Michael.Stängnäs 4246")

	if got != norm.NFD.String("INBOX.Kameo.Michael.Stängnäs 4246") {
		t.Fatalf("got %q, want the NFD form", got)
	}

	if got == "INBOX.Kameo.Michael.Stängnäs 4246" {
		t.Fatal("got the NFC form, want NFD")
	}
}

// TestFolderNamesArePrefixedForOneCom checks that one.com's INBOX namespace
// is applied.
func TestFolderNamesArePrefixedForOneCom(t *testing.T) {
	client := &Client{cfg: accountForTest()}

	if got := client.getFolderName("Kameo.Lån 5041"); got != norm.NFD.String("INBOX.Kameo.Lån 5041") {
		t.Fatalf("got %q, want the prefixed folder", got)
	}
}
