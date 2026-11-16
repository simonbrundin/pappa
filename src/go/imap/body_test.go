package imap

import (
	"strings"
	"testing"
)

func TestDecodeQuotedPrintable(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "Hej", "Hej"},
		{"hex", "=C3=A5", "å"},
		{"soft break", "abc=\r\ndef", "abcdef"},
		{"equals literal", "a=b", "a=b"},
		{"mixed", "L=C3=A5nenummer", "Lånenummer"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := string(decodeQuotedPrintable([]byte(tc.in)))
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDecodeTransferEncodingBase64(t *testing.T) {
	// "å" i base64
	got := decodeTransferEncoding([]byte("w6U=\n"), "base64")
	if string(got) != "å" {
		t.Fatalf("got %q, want %q", string(got), "å")
	}
}

func TestHtmlToText(t *testing.T) {
	html := `<html><body><p>Hej,</p><p><strong>Lånenummer:</strong> 4634</p></body></html>`
	got := htmlToText(html)
	if !strings.Contains(got, "Lånenummer:") {
		t.Fatalf("got %q, want it to contain Lånenummer:", got)
	}
	if strings.Contains(got, "<") {
		t.Fatalf("got %q, want no tags left", got)
	}
}

func TestDecodeMessageBodyQuotedPrintableHtml(t *testing.T) {
	raw := "Content-Type: text/html; charset=UTF-8\r\n" +
		"Content-Transfer-Encoding: quoted-printable\r\n" +
		"\r\n" +
		"<p>Du har tagit emot en r=C3=A4ntebetalning f=C3=B6r ett l=C3=A5n</p>\r\n"

	got := decodeMessageBody([]byte(raw))
	if !strings.Contains(got, "räntebetalning för ett lån") {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "=") {
		t.Fatalf("got %q, want no leftover quoted-printable", got)
	}
}

func TestDecodeMessageBodyMultipartPrefersPlain(t *testing.T) {
	raw := "Content-Type: multipart/alternative; boundary=\"X\"\r\n" +
		"\r\n" +
		"--X\r\n" +
		"Content-Type: text/plain; charset=UTF-8\r\n\r\n" +
		"Plaintext version\r\n" +
		"--X\r\n" +
		"Content-Type: text/html; charset=UTF-8\r\n\r\n" +
		"<p>HTML version</p>\r\n" +
		"--X--\r\n"

	got := decodeMessageBody([]byte(raw))
	if got != "Plaintext version" {
		t.Fatalf("got %q", got)
	}
}

func TestDecodeMessageBodyWindows1252(t *testing.T) {
	// Ränteutbetalning kodad som ISO-8859-1 (byte 0xE4 för 'ä').
	raw := "Content-Type: text/plain; charset=ISO-8859-1\r\n\r\n" +
		"R\xe4nteutbetalning\r\n"

	got := decodeMessageBody([]byte(raw))
	if !strings.Contains(got, "Ränteutbetalning") {
		t.Fatalf("got %q", got)
	}
}
