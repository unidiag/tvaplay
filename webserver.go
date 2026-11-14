package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

func webserver() {
	http.Handle("/build/", http.FileServer(http.FS(staticFiles)))
	ext := make(map[string]string)
	ext["html"] = "text/html"
	ext["json"] = "application/json"
	ext["css"] = "text/css"
	ext["js"] = "application/javascript"
	ext["gif"] = "image/gif"
	ext["svg"] = "image/svg+xml"
	ext["png"] = "image/png"
	ext["jpg"] = "image/jpeg"
	ext["jpeg"] = "image/jpeg"
	ext["ico"] = "image/x-icon"
	ext["woff"] = "font/woff"
	ext["woff2"] = "font/woff2"
	ext["ttf"] = "font/ttf"
	ext["eot"] = "application/vnd.ms-fontobject"

	// Файлы, которые можно кешировать на длительный срок.
	cacheableFiles := []string{
		".min.js",
		".min.css",
	}

	// Получаем содержимое корневой директории
	contents, err := readDirRecursively("build")
	if err != nil {
		log.Fatal(err)
	}

	for _, item := range contents {
		ff := item.Path
		route := strings.TrimPrefix(ff, "build")

		// main.css обслуживается отдельным обработчиком.
		if route == "/app/main.css" || route == "/manifest.json" ||
			route == "/favicon.ico" || route == "/logo192.png" ||
			route == "/logo512.png" {
			continue
		}

		// В debug содержимое /app/ отдаётся с диска.
		if debug && strings.HasPrefix(route, "/app/") {
			continue
		}

		http.HandleFunc(route, func(w http.ResponseWriter, r *http.Request) {
			file, err := staticFiles.ReadFile(ff)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}

			// Долгосрочное кеширование минифицированных файлов из /app/.
			if strings.HasPrefix(route, "/app/") {
				for _, pattern := range cacheableFiles {
					if strings.Contains(route, pattern) {
						w.Header().Set(
							"Cache-Control",
							"public, max-age=31536000, immutable",
						)
						break
					}
				}
			}

			w.Header().Set("Content-Type", ext[getFileExtension(ff)])
			_, _ = w.Write(file)
		})
	}

	// ██████╗ ██╗      █████╗ ██╗   ██╗██╗     ██╗███████╗████████╗
	// ██╔══██╗██║     ██╔══██╗╚██╗ ██╔╝██║     ██║██╔════╝╚══██╔══╝
	// ██████╔╝██║     ███████║ ╚████╔╝ ██║     ██║███████╗   ██║
	// ██╔═══╝ ██║     ██╔══██║  ╚██╔╝  ██║     ██║╚════██║   ██║
	// ██║     ███████╗██║  ██║   ██║   ███████╗██║███████║   ██║
	// ╚═╝     ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝╚══════╝   ╚═╝

	http.HandleFunc("/playlist.m3u", func(w http.ResponseWriter, r *http.Request) {
		setDevCORS(w, r)

		if r.Method == http.MethodOptions {
			if !debug {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}

			origin := r.Header.Get("Origin")
			if origin != "http://127.0.0.1:3000" &&
				origin != "http://localhost:3000" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}

			w.WriteHeader(http.StatusNoContent)
			return
		}

		servePlaylist(w, r)
	})

	//
	//
	//
	//
	//
	//

	//  █████╗ ██████╗ ██╗
	// ██╔══██╗██╔══██╗██║
	// ███████║██████╔╝██║
	// ██╔══██║██╔═══╝ ██║
	// ██║  ██║██║     ██║
	// ╚═╝  ╚═╝╚═╝     ╚═╝

	http.HandleFunc("/api/v2/", apiV2Handler)

	// История программы передач для архива TVAPLAY.
	http.HandleFunc("/api/epg/archive", func(
		w http.ResponseWriter,
		r *http.Request,
	) {
		setDevCORS(w, r)

		if r.Method == http.MethodOptions && debug {
			origin := r.Header.Get("Origin")
			if origin == "http://127.0.0.1:3000" ||
				origin == "http://localhost:3000" {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}

		serveEPGArchive(w, r)
	})

	// Создание сессии просмотра архивной передачи.
	http.HandleFunc("/api/archive/play", serveArchivePlay)

	// HLS VOD: плейлист и минутные TS.
	http.HandleFunc("/archive/", serveArchiveMedia)
	http.HandleFunc("/api/archive/search", serveArchiveSearch)

	http.HandleFunc("/languages.json", serveLanguagesJSON)
	http.HandleFunc("/manifest.json", serveManifestJSON)
	http.HandleFunc("/favicon.ico", serveGeneratedLogo)
	http.HandleFunc("/logo192.png", serveGeneratedLogo)
	http.HandleFunc("/logo512.png", serveGeneratedLogo)

	http.HandleFunc("/api", func(w http.ResponseWriter, r *http.Request) {
		setDevCORS(w, r)

		if r.Method == http.MethodOptions {
			if !debug {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}

			origin := r.Header.Get("Origin")
			if origin != "http://127.0.0.1:3000" &&
				origin != "http://localhost:3000" {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}

			w.WriteHeader(http.StatusNoContent)
			return
		} else if r.Method != http.MethodPost {
			w.Header().Set("Content-type", "application/json")
			http.Error(w, "{\"error\":\"Only POST data!\"}", http.StatusMethodNotAllowed)
			return
		} else {
			w.Header().Set("Content-type", "application/json")
			out := map[string]any{}
			in := map[string]any{}

			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, "Error read body request", http.StatusInternalServerError)
				return
			}
			err = json.Unmarshal(body, &in)
			if err != nil {
				fmt.Println("Error translate income JSON:", err)
				return
			}

			if _, ok := in["op"]; ok { // все остальные случаи только с проверкой подлинности пользователя
				out["data"] = api(in, r, w)
			} else {
				out["error"] = "No operation for API"
			}

			json, err := json.Marshal(out)
			if err != nil {
				slog("Fail transfer to JSON", "err")
				return
			}
			w.Write([]byte(json))
		}
	})

	http.HandleFunc("/api/hls/token", serveHLSToken)

	// Media Station X
	registerMSX()

	// HLS streaming proxy
	registerHLS()

	//  ██████╗ ██████╗      ██████╗ ██████╗ ██████╗ ███████╗        ██╗   ██╗██████╗     ██████╗  █████╗ ██╗      █████╗ ███╗   ██╗ ██████╗███████╗
	// ██╔═══██╗██╔══██╗    ██╔════╝██╔═══██╗██╔══██╗██╔════╝        ██║   ██║██╔══██╗    ██╔══██╗██╔══██╗██║     ██╔══██╗████╗  ██║██╔════╝██╔════╝
	// ██║   ██║██████╔╝    ██║     ██║   ██║██║  ██║█████╗          ██║   ██║██████╔╝    ██████╔╝███████║██║     ███████║██╔██╗ ██║██║     █████╗
	// ██║▄▄ ██║██╔══██╗    ██║     ██║   ██║██║  ██║██╔══╝          ██║   ██║██╔═══╝     ██╔══██╗██╔══██║██║     ██╔══██║██║╚██╗██║██║     ██╔══╝
	// ╚██████╔╝██║  ██║    ╚██████╗╚██████╔╝██████╔╝███████╗        ╚██████╔╝██║         ██████╔╝██║  ██║███████╗██║  ██║██║ ╚████║╚██████╗███████╗
	//  ╚══▀▀═╝ ╚═╝  ╚═╝     ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝         ╚═════╝ ╚═╝         ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝╚══════╝

	// serveUpBalanceQR генерирует JPEG с QR-кодом
	// банковской ссылки из настройки up_balance_url.
	// QR-код для пополнения баланса абонента.
	http.HandleFunc("/up_balance.jpg", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Получаем актуальную ссылку из настроек.
		link := strings.TrimSpace(getSetting("up_balance_url"))

		if link == "" {
			http.Error(w, "Payment URL is not configured",
				http.StatusServiceUnavailable)
			return
		}

		// Проверяем корректность ссылки.
		parsed, err := url.Parse(link)
		if err != nil || parsed.Host == "" ||
			(parsed.Scheme != "https" && parsed.Scheme != "http") {
			http.Error(w, "Invalid payment URL",
				http.StatusInternalServerError)
			return
		}

		// Создаём QR-код.
		qr, err := qrcode.New(link, qrcode.Medium)
		if err != nil {
			http.Error(w, "Cannot generate QR code",
				http.StatusInternalServerError)
			return
		}

		// Генерируем изображение 300x300.
		img := qr.Image(450)

		// Кодируем в JPEG до отправки заголовков.
		var buf bytes.Buffer

		err = jpeg.Encode(&buf, img, &jpeg.Options{
			Quality: 100,
		})
		if err != nil {
			http.Error(w, "Cannot encode JPEG",
				http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Length",
			strconv.Itoa(buf.Len()))

		if r.Method == http.MethodHead {
			return
		}

		_, _ = w.Write(buf.Bytes())
	})

	//  █████╗ ██████╗ ██████╗             ██╗███████╗        ██████╗███████╗███████╗
	// ██╔══██╗██╔══██╗██╔══██╗            ██║██╔════╝       ██╔════╝██╔════╝██╔════╝
	// ███████║██████╔╝██████╔╝            ██║███████╗       ██║     ███████╗███████╗
	// ██╔══██║██╔═══╝ ██╔═══╝        ██   ██║╚════██║       ██║     ╚════██║╚════██║
	// ██║  ██║██║     ██║         ██╗╚█████╔╝███████║    ██╗╚██████╗███████║███████║
	// ╚═╝  ╚═╝╚═╝     ╚═╝         ╚═╝ ╚════╝ ╚══════╝    ╚═╝ ╚═════╝╚══════╝╚══════╝

	http.HandleFunc("/app/main.js", serveMainJS)
	http.HandleFunc("/app/main.css", serveMainCSS)
	http.HandleFunc("/app/css/", serveThemeCSS)
	// Измерение скорости загрузки TVAPLAY → клиент.
	http.HandleFunc("/api/speedtest", serveSpeedTest)

	if debug {
		http.HandleFunc("/app/", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")

			http.StripPrefix(
				"/app/",
				http.FileServer(http.Dir("./frontend/public/app")),
			).ServeHTTP(w, r)
		})
	}

	http.HandleFunc("/admin/session", adminSession)

	/*	███╗   ███╗ █████╗ ██╗███╗   ██╗
		████╗ ████║██╔══██╗██║████╗  ██║
		██╔████╔██║███████║██║██╔██╗ ██║
		██║╚██╔╝██║██╔══██║██║██║╚██╗██║
		██║ ╚═╝ ██║██║  ██║██║██║ ╚████║
		╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝ */

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Разрешаем только главную страницу и админку.
		if path != "/" && path != "/admin" {
			http.NotFound(w, r)
			return
		}

		if path == "/admin" {
			if !adminAuthUser(r) {
				serveAdminBootstrap(w, r)
				return
			}
		}

		file, err := staticFiles.ReadFile("build/index.html")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		html := string(file)

		// Диагностика JavaScript только в debug.
		// if !debug {
		// 	re := regexp.MustCompile(
		// 		`(?is)<script>\s*window\.onerror\s*=\s*function\b.*?</script>`,
		// 	)
		// 	html = re.ReplaceAllString(html, "")
		// }

		if path != "/admin" {
			// Заменяем React JavaScript на ES5.
			reJS := regexp.MustCompile(
				`(?i)<script\b[^>]*src="/static/js/[^"]+\.js"[^>]*>\s*</script>`,
			)

			ver := VERSION

			if debug {
				ver = strconv.FormatInt(time.Now().UnixNano(), 10)
			}

			html = reJS.ReplaceAllString(
				html,
				fmt.Sprintf(
					`<script src="/app/jquery-2.2.4.min.js"></script><script src="/app/main.js?v=%s"></script>`,
					ver,
				),
			)

			// Подключаем выбранную тему до выполнения main.js.
			// При отсутствии настройки используем Graphite.
			reCSS := regexp.MustCompile(
				`(?i)<link\b[^>]*href="/static/css/[^"]+\.css"[^>]*>`,
			)

			html = reCSS.ReplaceAllStringFunc(html, func(_ string) string {
				return fmt.Sprintf(`<script>eval(function(p,a,c,k,e,r){e=function(c){return c.toString(a)};while(c--){if(k[c])p=p.replace(new RegExp("\\b"+e(c)+"\\b","g"),k[c])}return p}("(function(){var theme=\"default\";6{var 5=4.2.3(\"tvaplay_theme\");if(5&&/^[a-z0-9_-]+$/.test(5)){theme=5}}7(e){}0.1('<link id=\"tv-theme-css\" rel=\"stylesheet\" href=\"/app/css/'+theme+'.css?v=%s\">')})();",36,8,"document|write|localStorage|getItem|window|saved|try|catch".split("|"),0,{}))</script>`, ver)
			})

			// Убираем стандартное сообщение React.
			html = strings.ReplaceAll(
				html,
				"<noscript>You need to enable JavaScript to run this app.</noscript>",
				"",
			)
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")

		_, _ = w.Write([]byte(html))
	})

	// Запуск сервера на порту
	webport := ":8008"
	slog(APPNAME + " ver." + VERSION + " was run on the " + webport)
	log.Fatal(http.ListenAndServe(webport, nil))
}

//  ██████╗ ██████╗ ██████╗ ███████╗
// ██╔════╝██╔═══██╗██╔══██╗██╔════╝
// ██║     ██║   ██║██████╔╝███████╗
// ██║     ██║   ██║██╔══██╗╚════██║
// ╚██████╗╚██████╔╝██║  ██║███████║
//  ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝

func setDevCORS(w http.ResponseWriter, r *http.Request) {
	if !debug {
		return
	}

	origin := r.Header.Get("Origin")

	switch origin {
	case "http://127.0.0.1:3000",
		"http://localhost:3000":

		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")

		w.Header().Set(
			"Access-Control-Allow-Methods",
			"GET, POST, OPTIONS",
		)

		w.Header().Set(
			"Access-Control-Allow-Headers",
			"Content-Type, Authorization",
		)

		w.Header().Set("Access-Control-Max-Age", "600")
	}
}

func setHLSCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")

	switch origin {
	case "http://127.0.0.1:3000",
		"http://localhost:3000":

		w.Header().Set(
			"Access-Control-Allow-Origin",
			origin,
		)

		w.Header().Set(
			"Access-Control-Allow-Credentials",
			"true",
		)

		w.Header().Set(
			"Access-Control-Allow-Methods",
			"GET, HEAD, OPTIONS",
		)

		w.Header().Set(
			"Access-Control-Allow-Headers",
			"Content-Type, Authorization",
		)

		w.Header().Set("Access-Control-Max-Age", "600")
		w.Header().Add("Vary", "Origin")
	}
}

// serveManifestJSON формирует Web App Manifest из текущих настроек.
func serveManifestJSON(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	brandname := getSetting("brandname")
	manifest := struct {
		ShortName string `json:"short_name"`
		Name      string `json:"name"`
		Icons     []struct {
			Src   string `json:"src"`
			Sizes string `json:"sizes"`
			Type  string `json:"type"`
		} `json:"icons"`
		StartURL        string `json:"start_url"`
		Display         string `json:"display"`
		ThemeColor      string `json:"theme_color"`
		BackgroundColor string `json:"background_color"`
	}{
		ShortName:       brandname,
		Name:            "Middleware " + brandname,
		StartURL:        ".",
		Display:         "standalone",
		ThemeColor:      "#000000",
		BackgroundColor: "#ffffff",
	}
	manifest.Icons = append(manifest.Icons,
		struct {
			Src   string `json:"src"`
			Sizes string `json:"sizes"`
			Type  string `json:"type"`
		}{
			Src: "favicon.ico", Sizes: "64x64 32x32 24x24 16x16", Type: "image/x-icon",
		},
		struct {
			Src   string `json:"src"`
			Sizes string `json:"sizes"`
			Type  string `json:"type"`
		}{
			Src: "logo192.png", Sizes: "192x192", Type: "image/png",
		},
		struct {
			Src   string `json:"src"`
			Sizes string `json:"sizes"`
			Type  string `json:"type"`
		}{
			Src: "logo512.png", Sizes: "512x512", Type: "image/png",
		},
	)

	payload, err := json.Marshal(manifest)
	if err != nil {
		http.Error(w, "Cannot generate manifest", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(payload)
}

// loadLogoSource: явно заданный logo_path -> ./logo.png -> embedded build/logo.png.
// Изображение перечитывается при каждом запросе, поэтому изменения настроек
// и локального файла не требуют перезапуска сервера.
func loadLogoSource() (image.Image, error) {
	paths := []string{}
	if custom := strings.TrimSpace(getSetting("logo_path")); custom != "" {
		paths = append(paths, custom)
	}
	paths = append(paths, "logo.png")

	for _, path := range paths {
		f, err := os.Open(path)
		if err != nil {
			if !os.IsNotExist(err) {
				log.Printf("[LOGO] cannot open %q: %v", path, err)
			}
			continue
		}
		info, err := f.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > 16<<20 {
			_ = f.Close()
			log.Printf("[LOGO] invalid logo file %q", path)
			continue
		}
		// Не допускаем чрезмерно больших изображений.
		img, _, err := image.Decode(io.LimitReader(f, 16<<20))
		_ = f.Close()
		if err != nil {
			log.Printf("[LOGO] decode %q: %v", path, err)
			continue
		}
		if validLogoDimensions(img) {
			return img, nil
		}
		log.Printf("[LOGO] invalid dimensions in %q", path)
	}

	file, err := staticFiles.ReadFile("build/logo.png")
	if err != nil {
		return nil, fmt.Errorf("embedded build/logo.png: %w", err)
	}
	img, _, err := image.Decode(bytes.NewReader(file))
	if err != nil {
		return nil, fmt.Errorf("decode embedded logo.png: %w", err)
	}
	if !validLogoDimensions(img) {
		return nil, fmt.Errorf("invalid embedded logo dimensions")
	}
	return img, nil
}

func validLogoDimensions(img image.Image) bool {
	b := img.Bounds()
	return b.Dx() > 0 && b.Dy() > 0 && b.Dx() <= 4096 && b.Dy() <= 4096
}

// resizeLogo масштабирует с сохранением пропорций и прозрачными полями.
// Bilinear interpolation без дополнительных зависимостей.
func resizeLogo(src image.Image, size int) *image.NRGBA {
	dst := image.NewNRGBA(image.Rect(0, 0, size, size))
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	scale := math.Min(float64(size)/float64(sw), float64(size)/float64(sh))
	dw := int(math.Round(float64(sw) * scale))
	dh := int(math.Round(float64(sh) * scale))
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}
	dx := (size - dw) / 2
	dy := (size - dh) / 2

	for y := 0; y < dh; y++ {
		sy := (float64(y)+0.5)*float64(sh)/float64(dh) - 0.5
		y0 := int(math.Floor(sy))
		fy := sy - float64(y0)
		if y0 < 0 {
			y0, fy = 0, 0
		}
		if y0 >= sh-1 {
			y0, fy = sh-1, 0
		}
		y1 := y0 + 1
		if y1 >= sh {
			y1 = y0
		}
		for x := 0; x < dw; x++ {
			sx := (float64(x)+0.5)*float64(sw)/float64(dw) - 0.5
			x0 := int(math.Floor(sx))
			fx := sx - float64(x0)
			if x0 < 0 {
				x0, fx = 0, 0
			}
			if x0 >= sw-1 {
				x0, fx = sw-1, 0
			}
			x1 := x0 + 1
			if x1 >= sw {
				x1 = x0
			}
			c00 := color.NRGBAModel.Convert(src.At(b.Min.X+x0, b.Min.Y+y0)).(color.NRGBA)
			c10 := color.NRGBAModel.Convert(src.At(b.Min.X+x1, b.Min.Y+y0)).(color.NRGBA)
			c01 := color.NRGBAModel.Convert(src.At(b.Min.X+x0, b.Min.Y+y1)).(color.NRGBA)
			c11 := color.NRGBAModel.Convert(src.At(b.Min.X+x1, b.Min.Y+y1)).(color.NRGBA)
			// Интерполируем premultiplied RGB, чтобы избежать цветных ореолов.
			weights := [4]float64{(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy}
			cs := [4]color.NRGBA{c00, c10, c01, c11}
			var a, r, g, bb float64
			for i, c := range cs {
				alpha := float64(c.A) / 255
				a += weights[i] * alpha
				r += weights[i] * float64(c.R) * alpha
				g += weights[i] * float64(c.G) * alpha
				bb += weights[i] * float64(c.B) * alpha
			}
			out := color.NRGBA{A: uint8(math.Round(a * 255))}
			if a > 0 {
				out.R = uint8(math.Round(r / a))
				out.G = uint8(math.Round(g / a))
				out.B = uint8(math.Round(bb / a))
			}
			dst.SetNRGBA(dx+x, dy+y, out)
		}
	}
	return dst
}

// encodeICO делает классический Windows ICO с 32-bit BMP/DIB кадрами.
// Такой формат поддерживается в том числе старыми браузерами Smart TV.
func encodeICO(src image.Image) ([]byte, error) {
	sizes := []int{16, 24, 32, 64}
	frames := make([][]byte, len(sizes))
	for i, size := range sizes {
		img := resizeLogo(src, size)
		var frame bytes.Buffer
		// BITMAPINFOHEADER: высота удвоена для цветного изображения + AND mask.
		header := []uint32{40, uint32(size), uint32(size * 2)}
		for _, v := range header {
			_ = binary.Write(&frame, binary.LittleEndian, v)
		}
		_ = binary.Write(&frame, binary.LittleEndian, uint16(1))
		_ = binary.Write(&frame, binary.LittleEndian, uint16(32))
		pixelBytes := uint32(size * size * 4)
		maskStride := ((size + 31) / 32) * 4
		maskBytes := uint32(maskStride * size)
		for _, v := range []uint32{0, pixelBytes + maskBytes, 0, 0, 0, 0} {
			_ = binary.Write(&frame, binary.LittleEndian, v)
		}
		// BMP хранит строки снизу вверх, цвета BGRA.
		for y := size - 1; y >= 0; y-- {
			for x := 0; x < size; x++ {
				c := img.NRGBAAt(x, y)
				frame.Write([]byte{c.B, c.G, c.R, c.A})
			}
		}
		// 1 в AND mask = прозрачный пиксель.
		for y := size - 1; y >= 0; y-- {
			row := make([]byte, maskStride)
			for x := 0; x < size; x++ {
				if img.NRGBAAt(x, y).A == 0 {
					row[x/8] |= 1 << uint(7-x%8)
				}
			}
			frame.Write(row)
		}
		frames[i] = frame.Bytes()
	}

	var out bytes.Buffer
	_ = binary.Write(&out, binary.LittleEndian, uint16(0))
	_ = binary.Write(&out, binary.LittleEndian, uint16(1))
	_ = binary.Write(&out, binary.LittleEndian, uint16(len(sizes)))
	offset := uint32(6 + 16*len(sizes))
	for i, size := range sizes {
		out.WriteByte(byte(size))
		out.WriteByte(byte(size))
		out.WriteByte(0) // colors
		out.WriteByte(0) // reserved
		_ = binary.Write(&out, binary.LittleEndian, uint16(1))
		_ = binary.Write(&out, binary.LittleEndian, uint16(32))
		_ = binary.Write(&out, binary.LittleEndian, uint32(len(frames[i])))
		_ = binary.Write(&out, binary.LittleEndian, offset)
		offset += uint32(len(frames[i]))
	}
	for _, frame := range frames {
		_, _ = out.Write(frame)
	}
	return out.Bytes(), nil
}

func serveGeneratedLogo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	img, err := loadLogoSource()
	if err != nil {
		log.Printf("[LOGO] %v", err)
		http.Error(w, "Logo unavailable", http.StatusServiceUnavailable)
		return
	}

	var buf bytes.Buffer
	contentType := "image/png"
	switch r.URL.Path {
	case "/favicon.ico":
		data, err := encodeICO(img)
		if err != nil {
			log.Printf("[LOGO] favicon: %v", err)
			http.Error(w, "Cannot generate favicon", http.StatusInternalServerError)
			return
		}
		_, _ = buf.Write(data)
		contentType = "image/x-icon"
	case "/logo192.png", "/logo512.png":
		size := 192
		if r.URL.Path == "/logo512.png" {
			size = 512
		}
		if err := png.Encode(&buf, resizeLogo(img, size)); err != nil {
			http.Error(w, "Cannot generate logo", http.StatusInternalServerError)
			return
		}
	default:
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.Itoa(buf.Len()))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(buf.Bytes())
}
