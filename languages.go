package main

import (
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strings"
)

const languageDirectory = "build/app/lang"

var languageCodePattern = regexp.MustCompile(
	`^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$`,
)

type languageEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type languageCatalog struct {
	Default   string          `json:"default"`
	Languages []languageEntry `json:"languages"`
}

// Определяем язык по коду страны ISO 3166-1.

func defaultLanguageByCountry(country string) string {
	country = strings.ToUpper(strings.TrimSpace(country))

	switch country {

	// Беларуская
	case "BY":
		return "be"

	// Русский — Россия и страны СНГ
	case "RU", "AM", "AZ", "KZ", "KG",
		"MD", "TJ", "TM", "UZ":
		return "ru"

	// Українська
	case "UA":
		return "uk"

	// ქართული
	case "GE":
		return "ka"

	// Polski
	case "PL":
		return "pl"

	// Lietuvių
	case "LT":
		return "lt"

	// Latviešu
	case "LV":
		return "lv"

	// Eesti
	case "EE":
		return "et"

	// Deutsch
	case "DE", "AT", "CH", "LI":
		return "de"

	// Français
	case "FR", "BE", "LU", "MC",
		"CI", "SN", "CM", "CD", "CG",
		"GA", "BJ", "TG", "BF", "NE",
		"ML", "TD", "CF", "DJ", "GN":
		return "fr"

	// Türkçe
	case "TR", "CY":
		return "tr"

	// العربية — арабоязычные страны
	case "EG", "SA", "AE", "QA", "KW",
		"BH", "OM", "JO", "LB", "SY",
		"IQ", "YE", "PS", "MA", "DZ",
		"TN", "LY", "SD", "MR", "SO":
		return "ar"

	// Español — Испания и испаноязычная Латинская Америка
	case "ES", "MX", "GT", "HN", "SV",
		"NI", "CR", "PA", "CU", "DO",
		"PR", "CO", "VE", "EC", "PE",
		"BO", "PY", "CL", "AR", "UY",
		"GQ":
		return "es"

	// English — все остальные страны
	default:
		return "en"
	}
}

// Возвращает IP непосредственного HTTP-клиента.
//
// Если сервер работает за Nginx, здесь следует использовать
// существующую в проекте функцию получения реального IP,
// которая доверяет заголовкам только от настроенного proxy.
func languageClientIP(r *http.Request) string {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return ip
	}

	return r.RemoteAddr
}

// GET /languages.json
func serveLanguagesJSON(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Получаем IPv4 пользователя через Nginx.
	ip := getClientIP(r)

	// Определяем страну по GeoIP.
	country := geoIP(ip)

	// Выбираем язык по стране.
	defaultLang := defaultLanguageByCountry(country)

	// Считываем языки из embed.FS.
	entries, err := fs.ReadDir(staticFiles, languageDirectory)
	if err != nil {
		http.Error(
			w,
			"Language directory unavailable",
			http.StatusInternalServerError,
		)
		return
	}

	catalog := languageCatalog{
		Default:   defaultLang,
		Languages: make([]languageEntry, 0, len(entries)),
	}

	hasEnglish := false
	hasDefault := false

	for _, entry := range entries {
		if !entry.Type().IsRegular() ||
			!strings.HasSuffix(entry.Name(), ".json") {
			continue
		}

		code := strings.TrimSuffix(entry.Name(), ".json")

		if !languageCodePattern.MatchString(code) {
			continue
		}

		data, err := fs.ReadFile(
			staticFiles,
			path.Join(languageDirectory, entry.Name()),
		)
		if err != nil {
			continue
		}

		var document struct {
			Meta struct {
				NativeName string `json:"native_name"`
			} `json:"meta"`
		}

		if err := json.Unmarshal(data, &document); err != nil {
			continue
		}

		name := strings.TrimSpace(document.Meta.NativeName)
		if name == "" {
			continue
		}

		catalog.Languages = append(
			catalog.Languages,
			languageEntry{
				ID:   code,
				Name: name,
			},
		)

		if code == "en" {
			hasEnglish = true
		}
		if code == defaultLang {
			hasDefault = true
		}
	}

	// Английский словарь обязателен.
	if !hasEnglish {
		http.Error(
			w,
			"Default English language is missing",
			http.StatusInternalServerError,
		)
		return
	}

	// Если географически выбранного языка нет,
	// используем английский.
	if !hasDefault {
		catalog.Default = "en"
	}

	// Английский первым, остальные по коду языка.
	sort.Slice(catalog.Languages, func(i, j int) bool {
		a := catalog.Languages[i].ID
		b := catalog.Languages[j].ID

		if a == "en" {
			return true
		}
		if b == "en" {
			return false
		}

		return a < b
	})

	w.Header().Set(
		"Content-Type",
		"application/json; charset=utf-8",
	)

	_ = json.NewEncoder(w).Encode(catalog)
}
