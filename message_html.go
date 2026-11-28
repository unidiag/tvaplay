package main

import (
	"bytes"
	"net/url"
	"regexp"
	"strings"

	"github.com/microcosm-cc/bluemonday"
	"golang.org/x/net/html"
)

var messageHTMLPolicy = newMessageHTMLPolicy()

func newMessageHTMLPolicy() *bluemonday.Policy {
	p := bluemonday.NewPolicy()
	p.AllowElements("p", "div", "br", "span", "b", "strong", "i", "em", "u", "s", "strike", "h2", "h3", "ul", "ol", "li", "blockquote", "hr", "img")
	p.RequireParseableURLs(true)
	p.AllowRelativeURLs(false)
	p.AllowURLSchemes("https")
	p.AllowAttrs("src").Matching(regexp.MustCompile(`(?i)^https://[^\s]+$`)).OnElements("img")
	p.AllowAttrs("alt").OnElements("img")
	p.AllowAttrs("align").Matching(regexp.MustCompile(`^(left|center|right)$`)).OnElements("div", "p", "h2", "h3")
	return p
}

func messageImageURLValid(value string) bool {
	u, err := url.Parse(value)
	return err == nil && u != nil && strings.EqualFold(u.Scheme, "https") && u.Hostname() != "" && u.User == nil && !strings.ContainsAny(value, "\\\r\n\t")
}

// Sanitize first, then remove images with invalid URLs from the parsed fragment.
func sanitizeMessageHTML(body string) string {
	clean := messageHTMLPolicy.Sanitize(body)
	doc, err := html.Parse(strings.NewReader(clean))
	if err != nil {
		return ""
	}
	var out bytes.Buffer
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for child := n.FirstChild; child != nil; {
			next := child.NextSibling
			if child.Type == html.ElementNode && child.Data == "img" {
				valid := false
				for _, a := range child.Attr {
					if a.Key == "src" && messageImageURLValid(a.Val) {
						valid = true
					}
				}
				if !valid {
					n.RemoveChild(child)
				}
			} else {
				walk(child)
			}
			child = next
		}
	}
	walk(doc)
	var findBody func(*html.Node) *html.Node
	findBody = func(n *html.Node) *html.Node {
		if n.Type == html.ElementNode && n.Data == "body" {
			return n
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if b := findBody(c); b != nil {
				return b
			}
		}
		return nil
	}
	root := findBody(doc)
	if root == nil {
		return ""
	}
	for c := root.FirstChild; c != nil; c = c.NextSibling {
		if html.Render(&out, c) != nil {
			return ""
		}
	}
	return strings.TrimSpace(out.String())
}

func messageHTMLPlainText(body string) string {
	doc, err := html.Parse(strings.NewReader(sanitizeMessageHTML(body)))
	if err != nil {
		return ""
	}
	var out strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			out.WriteString(n.Data)
			return
		}
		block := false
		if n.Type == html.ElementNode {
			switch n.Data {
			case "head", "script", "style", "img":
				return
			case "br", "hr":
				out.WriteByte('\n')
				return
			case "p", "div", "h2", "h3", "li", "ul", "ol", "blockquote":
				block = true
			}
		}
		if block {
			out.WriteByte('\n')
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
		if block {
			out.WriteByte('\n')
		}
	}
	walk(doc)
	text := strings.ReplaceAll(out.String(), "\u00a0", " ")
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = strings.Join(strings.Fields(lines[i]), " ")
	}
	text = strings.Join(lines, "\n")
	for strings.Contains(text, "\n\n\n") {
		text = strings.ReplaceAll(text, "\n\n\n", "\n\n")
	}
	return strings.TrimSpace(text)
}

func messageHTMLHasContent(body string) bool {
	clean := sanitizeMessageHTML(body)
	if messageHTMLPlainText(clean) != "" {
		return true
	}
	doc, err := html.Parse(strings.NewReader(clean))
	if err != nil {
		return false
	}
	var hasImage func(*html.Node) bool
	hasImage = func(n *html.Node) bool {
		if n.Type == html.ElementNode && n.Data == "img" {
			for _, a := range n.Attr {
				if a.Key == "src" && messageImageURLValid(a.Val) {
					return true
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if hasImage(c) {
				return true
			}
		}
		return false
	}
	return hasImage(doc)
}
