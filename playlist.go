package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"main/models"
)

// Поддерживаем пути:
// /s1490/index.m3u8
// /cam1/index.m3u8
// /test-tv/index.m3u8
var playlistHLSRegex = regexp.MustCompile(
	`^/(s[0-9]+|[a-zA-Z0-9_-]+)/index\.m3u8$`,
)

// Для связи с EPG:
// s1490 -> 1490
var playlistEPGRegex = regexp.MustCompile(`^s([0-9]+)$`)

// Запись из master_dtv.
type playlistDTV struct {
	ID     uint64 `gorm:"column:id"`
	Name   string `gorm:"column:name"`
	Server string `gorm:"column:server"`
	LCN    uint16 `gorm:"column:lcn"`
	Output string `gorm:"column:output"`
}

// Готовая запись M3U.
type playlistChannel struct {
	ID       string
	Name     string
	Icon     string
	Group    string
	URL      string
	LCN      uint16
	MasterID uint64
	HasEPG   bool
}

// Удаляем символы, которые могут повредить M3U.
func m3uEscape(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, `"`, "'")
	return strings.TrimSpace(s)
}

// Создаём обратную карту:
// IP:PORT -> hls/hls2/hls3.
func playlistServerRoutes() map[string]string {
	routes := make(map[string]string, len(HLSUpstreams))

	for route, address := range HLSUpstreams {
		address = strings.TrimSpace(address)

		if address == "" {
			continue
		}

		routes[address] = route
	}

	return routes
}

// Извлекаем путь HLS из JSON-массива output.
//
// Например:
// ["udp://...", "http://0:8000/cam1/index.m3u8"]
//
// Результат:
// /cam1/index.m3u8
func playlistHLSPath(output string) string {
	var outputs []string

	if err := json.Unmarshal(
		[]byte(output),
		&outputs,
	); err != nil {
		return ""
	}

	for _, raw := range outputs {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil {
			continue
		}

		// Используем только HTTP/HTTPS.
		if u.Scheme != "http" && u.Scheme != "https" {
			continue
		}

		if u.Host == "" || u.User != nil {
			continue
		}

		// Проверяем формат пути.
		if !playlistHLSRegex.MatchString(u.Path) {
			continue
		}

		// Сохраняем путь и параметры запроса.
		if u.RawQuery != "" {
			return u.Path + "?" + u.RawQuery
		}

		return u.Path
	}

	return ""
}

// Извлекаем EPG ID только из sNNNN.
//
// /s1490/index.m3u8 -> 1490
// /cam1/index.m3u8  -> ""
func playlistEPGID(hlsPath string) string {
	u, err := url.Parse(hlsPath)
	if err != nil {
		return ""
	}

	matches := playlistHLSRegex.FindStringSubmatch(u.Path)
	if len(matches) != 2 {
		return ""
	}

	epgMatches := playlistEPGRegex.FindStringSubmatch(matches[1])
	if len(epgMatches) != 2 {
		return ""
	}

	return epgMatches[1]
}

// Загружаем и формируем список каналов.
//
// Основной источник: master_dtv.
// Дополнительная информация: iptv_epg_channels.
func playlistLoadChannels(
	r *http.Request,
) ([]playlistChannel, error) {

	// Загружаем только каналы с LCN > 0.
	var entries []playlistDTV

	if err := db.WithContext(r.Context()).
		Table("master_dtv").
		Select("id", "name", "server", "lcn", "output").
		Where("lcn > ?", 0).
		Order("lcn ASC").
		Order("id ASC").
		Find(&entries).Error; err != nil {
		return nil, err
	}

	// Загружаем EPG-каналы.
	var epgChannels []models.EPGChannel

	if err := db.WithContext(r.Context()).
		Find(&epgChannels).Error; err != nil {
		return nil, err
	}

	// Карта EPG ID -> информация о канале.
	epgMap := make(map[string]models.EPGChannel, len(epgChannels))

	for _, ch := range epgChannels {
		epgMap[ch.ID] = ch
	}

	// Карта серверов из config.go.
	serverRoutes := playlistServerRoutes()

	channels := make([]playlistChannel, 0, len(entries))

	for _, entry := range entries {
		// Определяем публичный HLS-маршрут.
		route, ok := serverRoutes[strings.TrimSpace(entry.Server)]
		if !ok {
			continue
		}

		// Получаем путь HLS из output.
		hlsPath := playlistHLSPath(entry.Output)
		if hlsPath == "" {
			continue
		}

		// Формируем публичный адрес.
		hlsURL := fmt.Sprintf(
			"%s/%s%s",
			strings.TrimRight(playlistHLSBaseURL, "/"),
			route,
			hlsPath,
		)

		// Базовая информация из master_dtv.
		item := playlistChannel{
			Name:     entry.Name,
			URL:      hlsURL,
			LCN:      entry.LCN,
			MasterID: entry.ID,
			Group:    EPGCategories["general"],
		}

		// Проверяем связь с EPG.
		epgID := playlistEPGID(hlsPath)

		if epgID != "" {
			if epg, exists := epgMap[epgID]; exists {
				item.ID = epg.ID
				item.Name = epg.Name
				item.Icon = epg.Icon
				item.HasEPG = true

				// Категория из EPG.
				if groupName, ok := EPGCategories[epg.Category]; ok {
					item.Group = groupName
				}
			}
		}

		// Пропускаем записи без названия.
		if strings.TrimSpace(item.Name) == "" {
			continue
		}

		channels = append(channels, item)
	}

	// Сортировка по LCN.
	sort.SliceStable(channels, func(i, j int) bool {
		a := channels[i]
		b := channels[j]

		if a.LCN != b.LCN {
			return a.LCN < b.LCN
		}

		// При одинаковом LCN — по названию.
		if a.Name != b.Name {
			return a.Name < b.Name
		}

		return a.MasterID < b.MasterID
	})

	return channels, nil
}

// Генерация M3U-плейлиста.
func servePlaylist(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)

		http.Error(
			w,
			"Method not allowed",
			http.StatusMethodNotAllowed,
		)
		return
	}

	if !isAllowedTVRequest(r) {
		http.Error(
			w,
			"Forbidden",
			http.StatusForbidden,
		)
		return
	}

	// Загружаем каналы из master_dtv + EPG.
	channels, err := playlistLoadChannels(r)
	if err != nil {
		http.Error(
			w,
			"Database error",
			http.StatusInternalServerError,
		)
		return
	}

	w.Header().Set(
		"Content-Type",
		"audio/x-mpegurl; charset=utf-8",
	)

	w.Header().Set(
		"Content-Disposition",
		`inline; filename="playlist.m3u"`,
	)

	w.Header().Set(
		"Cache-Control",
		"private, no-store",
	)

	bw := bufio.NewWriter(w)
	defer bw.Flush()

	fmt.Fprintln(bw, "#EXTM3U")

	for _, ch := range channels {
		if ch.HasEPG {
			// Телеканал с программой передач.
			fmt.Fprintf(
				bw,
				`#EXTINF:-1 tvg-id="%s" tvg-name="%s" tvg-logo="%s" group-title="%s",%s`+"\n",
				m3uEscape(ch.ID),
				m3uEscape(ch.Name),
				m3uEscape(ch.Icon),
				m3uEscape(ch.Group),
				m3uEscape(ch.Name),
			)
		} else {
			// Канал без EPG (например, cam1).
			fmt.Fprintf(
				bw,
				`#EXTINF:-1 tvg-name="%s" group-title="%s",%s`+"\n",
				m3uEscape(ch.Name),
				m3uEscape(ch.Group),
				m3uEscape(ch.Name),
			)
		}

		fmt.Fprintln(bw, ch.URL)
	}
}
