package main

import (
	"bytes"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/tdewolff/minify/v2"
	"github.com/tdewolff/minify/v2/css"
	"github.com/tdewolff/minify/v2/js"
)

var (
	jsCache     []byte
	jsCacheOnce sync.Once
	jsCacheErr  error
)

// Для модулей вида 00-core.js, 01-device.js.
var jsModulePattern = regexp.MustCompile(`^[0-9]{2}-[a-zA-Z0-9_-]+\.js$`)

// В production читаем из Go embed.
// В debug читаем с диска.
func getJSFileSystem() (fs.FS, error) {
	if debug {
		return os.DirFS("./frontend/public/app/js"), nil
	}

	return fs.Sub(staticFiles, "build/app/js")
}

// Собираем исходники по имени файла.
func buildJavaScript() ([]byte, error) {
	sourceFS, err := getJSFileSystem()
	if err != nil {
		return nil, err
	}

	entries, err := fs.ReadDir(sourceFS, ".")
	if err != nil {
		return nil, fmt.Errorf("read js directory: %w", err)
	}

	var names []string

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		name := entry.Name()

		if jsModulePattern.MatchString(name) {
			names = append(names, name)
		}
	}

	sort.Strings(names)

	if len(names) == 0 {
		return nil, fmt.Errorf("no JS modules found")
	}

	var buffer bytes.Buffer

	for _, name := range names {
		data, err := fs.ReadFile(sourceFS, name)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", name, err)
		}

		// Начало модуля с комментарием для debug.
		buffer.WriteString("\n/* MODULE: ")
		buffer.WriteString(name)
		buffer.WriteString(" */\n")

		buffer.Write(data)

		// Защита от склеивания выражений
		// между разными файлами.
		buffer.WriteString("\n;\n")
	}

	result := buffer.Bytes()

	// В debug оставляем читаемый код.
	if debug {
		return result, nil
	}

	// В production минифицируем.
	m := minify.New()
	m.Add("application/javascript", &js.Minifier{
		//Version:      2015,
		Version:      2009, // ECMAScript 5
		KeepVarNames: false,
	})

	minified, err := m.Bytes("application/javascript", result)
	if err != nil {
		return nil, fmt.Errorf("minify JavaScript: %w", err)
	}

	return minified, nil
}

// GET /app/main.js
func serveMainJS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var data []byte
	var err error

	if debug {
		// Каждый запрос перечитывает исходники.
		data, err = buildJavaScript()
		w.Header().Set("Cache-Control", "no-store")
	} else {
		// Один раз собираем и минифицируем
		// за время работы процесса.
		jsCacheOnce.Do(func() {
			jsCache, jsCacheErr = buildJavaScript()
		})

		data = jsCache
		err = jsCacheErr

		w.Header().Set("Cache-Control", "public, max-age=3600")
	}

	if err != nil {
		http.Error(
			w,
			"JavaScript build error: "+err.Error(),
			http.StatusInternalServerError,
		)
		return
	}

	w.Header().Set(
		"Content-Type",
		"application/javascript; charset=utf-8",
	)
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// Для разработки и диагностики.
	if debug {
		w.Header().Set("X-JS-Build", "debug")
	} else {
		w.Header().Set("X-JS-Build", "production")
	}

	w.Header().Set("Content-Length", fmt.Sprint(len(data)))

	if r.Method == http.MethodHead {
		return
	}

	_, _ = w.Write(data)
}

// Проверяем, относится ли путь к собираемому main.js.
func isGeneratedJSPath(path string) bool {
	return strings.TrimSpace(path) == "/app/main.js"
}

//  ██████╗███████╗███████╗
// ██╔════╝██╔════╝██╔════╝
// ██║     ███████╗███████╗
// ██║     ╚════██║╚════██║
// ╚██████╗███████║███████║
//  ╚═════╝╚══════╝╚══════╝

var (
	cssCache     []byte
	cssCacheOnce sync.Once
	cssCacheErr  error
)

func buildCSS() ([]byte, error) {
	var data []byte
	var err error

	if debug {
		data, err = os.ReadFile("./frontend/public/app/main.css")
	} else {
		data, err = staticFiles.ReadFile("build/app/main.css")
	}
	if err != nil {
		return nil, err
	}

	if debug {
		return data, nil
	}

	m := minify.New()
	m.AddFunc("text/css", css.Minify)

	return m.Bytes("text/css", data)
}

func serveMainCSS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var data []byte
	var err error

	if debug {
		data, err = buildCSS()
		w.Header().Set("Cache-Control", "no-store")
	} else {
		cssCacheOnce.Do(func() {
			cssCache, cssCacheErr = buildCSS()
		})
		data, err = cssCache, cssCacheErr
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}

	if err != nil {
		http.Error(w, fmt.Sprintf("CSS build error: %v", err),
			http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(data)))

	if r.Method == http.MethodHead {
		return
	}

	_, _ = w.Write(data)
}
