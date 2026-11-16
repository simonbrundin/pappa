package imap

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"regexp"
	"strings"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/transform"
)

// tagPattern matchar inbäddad HTML (t.ex. "<img src=3D" efter QP-avkodning).
var tagPattern = regexp.MustCompile(`(?s)<[^>]*>`)

// scriptStylePattern tar bort inlägg som inte ska visas som text.
var scriptStylePattern = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)

// decodeBody avkodar ett rått MIME-part till läsbar UTF-8-text.
//
// Kedjan är: transfer-encoding (quoted-printable/base64) -> charset -> text.
// HTML tas bort så att resultatet går att skriva ut i en PDF.
func decodeBody(raw []byte, contentType string, transferEncoding string) string {
	body := decodeTransferEncoding(raw, transferEncoding)

	mediaType, params, _ := mime.ParseMediaType(contentType)
	if mediaType == "" {
		mediaType = "text/plain"
	}

	text := decodeCharset(body, params["charset"])

	if strings.HasPrefix(mediaType, "text/html") {
		text = htmlToText(text)
	}

	return strings.TrimSpace(text)
}

// decodeTransferEncoding avkodar quoted-printable och base64.
func decodeTransferEncoding(raw []byte, encoding string) []byte {
	switch strings.ToLower(strings.TrimSpace(encoding)) {
	case "quoted-printable":
		return decodeQuotedPrintable(raw)
	case "base64":
		cleaned := strings.Map(func(r rune) rune {
			if r == '\r' || r == '\n' || r == ' ' || r == '\t' {
				return -1
			}
			return r
		}, string(raw))
		decoded, err := base64.StdEncoding.DecodeString(cleaned)
		if err != nil {
			return raw
		}
		return decoded
	default:
		return raw
	}
}

// decodeQuotedPrintable avkodar quoted-printable enligt RFC 2045.
func decodeQuotedPrintable(raw []byte) []byte {
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c != '=' {
			out = append(out, c)
			continue
		}

		// Mjuk radbrytning: "=\r\n" eller "=\n".
		if i+1 < len(raw) && raw[i+1] == '\n' {
			i++
			continue
		}
		if i+2 < len(raw) && raw[i+1] == '\r' && raw[i+2] == '\n' {
			i += 2
			continue
		}

		if i+2 < len(raw) {
			hi, okHi := hexValue(raw[i+1])
			lo, okLo := hexValue(raw[i+2])
			if okHi && okLo {
				out = append(out, hi<<4|lo)
				i += 2
				continue
			}
		}

		out = append(out, c)
	}
	return out
}

func hexValue(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	}
	return 0, false
}

// decodeCharset konverterar texten till UTF-8 utifrån angiven charset.
func decodeCharset(body []byte, charset string) string {
	switch strings.ToLower(strings.TrimSpace(charset)) {
	case "", "utf-8", "utf8", "us-ascii":
		return string(body)
	case "iso-8859-1", "latin1":
		decoded, _, err := transform.Bytes(charmap.ISO8859_1.NewDecoder(), body)
		if err != nil {
			return string(body)
		}
		return string(decoded)
	case "windows-1252", "cp1252":
		decoded, _, err := transform.Bytes(charmap.Windows1252.NewDecoder(), body)
		if err != nil {
			return string(body)
		}
		return string(decoded)
	default:
		return string(body)
	}
}

// htmlToText gör om HTML till läsbar text.
func htmlToText(html string) string {
	text := scriptStylePattern.ReplaceAllString(html, " ")
	text = tagPattern.ReplaceAllString(text, " ")

	// block-element ger en ny rad
	text = regexp.MustCompile(`(?i)<\s*(br|/p|/div|/tr|/li|/h[1-6])[^>]*>`).ReplaceAllString(text, "\n")
	text = regexp.MustCompile(`(?i)</\s*(p|div|tr|li|h[1-6]|table)\s*>`).ReplaceAllString(text, "\n")

	replacer := strings.NewReplacer(
		"&nbsp;", " ",
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
	)
	text = replacer.Replace(text)

	lines := strings.Split(text, "\n")
	cleaned := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.Join(strings.Fields(line), " ")
		if line != "" {
			cleaned = append(cleaned, line)
		}
	}
	return strings.Join(cleaned, "\n")
}

// decodeMessageBody tar fram brödtexten ur ett rått RFC 822-meddelande.
//
// text/plain väljs i företräde framför text/html. Finns ingen textdel
// returneras html-texten, avkodad.
func decodeMessageBody(raw []byte) string {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		// Fallback: rått innehåll som text.
		return strings.TrimSpace(string(raw))
	}

	contentType := msg.Header.Get("Content-Type")
	mediaType, params, _ := mime.ParseMediaType(contentType)
	if mediaType == "" {
		mediaType = "text/plain"
	}

	if strings.HasPrefix(mediaType, "multipart/") {
		if boundary := params["boundary"]; boundary != "" {
			reader := multipart.NewReader(msg.Body, boundary)
			plain, html := "", ""
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					break
				}
				partType, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
				if partType == "" {
					partType = "text/plain"
				}
				if !strings.HasPrefix(partType, "text/") {
					part.Close()
					continue
				}
				content, err := io.ReadAll(part)
				if err != nil {
					part.Close()
					continue
				}
				decoded := decodeBody(content, part.Header.Get("Content-Type"), part.Header.Get("Content-Transfer-Encoding"))
				if partType == "text/plain" && plain == "" {
					plain = decoded
				} else if partType == "text/html" && html == "" {
					html = decoded
				}
				part.Close()
			}
			if plain != "" {
				return plain
			}
			return html
		}
	}

	content, err := io.ReadAll(msg.Body)
	if err != nil {
		return ""
	}
	return decodeBody(content, contentType, msg.Header.Get("Content-Transfer-Encoding"))
}

// rawMessageText returnerar hela meddelandet som text.
func rawMessageText(reader io.Reader) (string, error) {
	data, err := io.ReadAll(reader)
	if err != nil {
		return "", fmt.Errorf("failed to read message: %w", err)
	}
	return decodeMessageBody(data), nil
}
