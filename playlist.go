package main

import (
	"bufio"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"

	"main/models"
)

// Канал, подготовленный для M3U.
type playlistChannel struct {
	ID       uint32
	Name     string
	EPGID    string
	Icon     string
	Group    string
	URL      string
	Position uint16
	Record   uint16
	HasEPG   bool
}

// Удаляем символы, которые могут нарушить M3U.
func m3uEscape(s string) string {
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, `"`, "'")

	return strings.TrimSpace(s)
}

// Проверяем и нормализуем адрес потока.
//
// Сейчас допускаем:
// udp://239.0.0.1:1234
// udp://@239.0.0.1:1234
// http://server/channel/index.m3u8
// https://server/channel/index.m3u8
//
// ВАЖНО:
// UDP остаётся UDP. Функция не выполняет
// преобразование UDP в HLS.
func playlistStreamURL(raw string) string {
	raw = strings.TrimSpace(raw)

	if raw == "" {
		return ""
	}

	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}

	switch strings.ToLower(u.Scheme) {
	case "udp":
		if u.Host == "" {
			return ""
		}

		// Сохраняем оригинальный UDP URI.
		return raw

	case "http", "https":
		if u.Host == "" || u.User != nil {
			return ""
		}

		return raw

	default:
		return ""
	}
}

func playlistLoadChannels(
	r *http.Request,
	userID uint,
) ([]playlistChannel, error) {

	var entries []models.Channel

	err := db.WithContext(r.Context()).
		Model(&models.Channel{}).
		Where("channels.enable = ?", 1).
		Where(`
        EXISTS (
            SELECT 1
            FROM channel_packages cp
            INNER JOIN user_packages up
                ON up.package_id = cp.package_id
            INNER JOIN packages p
                ON p.id = cp.package_id
            WHERE cp.channel_id = channels.id
              AND up.user_id = ?
              AND p.enabled = 1
        )
    `, userID).
		Order("channels.position ASC").
		Order("channels.id ASC").
		Find(&entries).Error

	if err != nil {
		return nil, fmt.Errorf("load channels: %w", err)
	}

	log.Printf(
		"[PLAYLIST] loaded channels from DB: %d",
		len(entries),
	)

	var epgChannels []models.EPGChannel

	err = db.WithContext(r.Context()).
		Select("id", "icon", "category").
		Find(&epgChannels).Error

	if err != nil {
		return nil, fmt.Errorf(
			"load EPG channels: %w",
			err,
		)
	}

	epgMap := make(
		map[string]models.EPGChannel,
		len(epgChannels),
	)

	for _, epg := range epgChannels {
		epgMap[epg.ID] = epg
	}

	channels := make(
		[]playlistChannel,
		0,
		len(entries),
	)

	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name)
		if name == "" {
			continue
		}

		item := playlistChannel{
			ID:    entry.ID,
			Name:  name,
			EPGID: strings.TrimSpace(entry.EPGID),
			URL: fmt.Sprintf(
				"/live/%d/index.m3u8",
				entry.ID,
			),
			Position: entry.Position,
			Record:   entry.Record,

			// Всегда используем базовый ключ категории.
			Group: "general",
		}

		if item.EPGID != "" {
			if epg, ok := epgMap[item.EPGID]; ok {
				item.Icon = strings.TrimSpace(epg.Icon)
				item.HasEPG = true

				// Берём ключ категории из EPG.
				category := strings.ToLower(
					strings.TrimSpace(epg.Category),
				)

				// Проверяем допустимость категории.
				if _, exists := EPGCategories[category]; exists {
					item.Group = category
				}
			}
		}

		channels = append(channels, item)
	}

	return channels, nil
}

// Генерация M3U-плейлиста.
func servePlaylist(
	w http.ResponseWriter,
	r *http.Request,
) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)

		http.Error(
			w,
			"Method not allowed",
			http.StatusMethodNotAllowed,
		)
		return
	}

	// JWT-авторизацию сохраняем.
	user, err := getAuthUser(r)

	if err != nil || user == nil {
		w.Header().Set("Cache-Control", "no-store")

		http.Error(
			w,
			"Unauthorized",
			http.StatusUnauthorized,
		)
		return
	}

	// Загружаем каналы из пакетов пользователя.
	channels, err := playlistLoadChannels(r, user.ID)

	if err != nil {
		log.Printf(
			"[PLAYLIST] database error: %v",
			err,
		)

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

		// Служебные атрибуты M3U.
		//
		// tvg-chno — порядок отображения.
		// tvg-id   — EPG ID.
		// tvg-logo — иконка EPG.
		// group-title — категория канала.

		attrs := fmt.Sprintf(
			` tvg-chno="%d"`,
			ch.Position,
		)

		if ch.EPGID != "" {
			attrs += fmt.Sprintf(
				` tvg-id="%s"`,
				m3uEscape(ch.EPGID),
			)
		}

		attrs += fmt.Sprintf(
			` tvg-name="%s"`,
			m3uEscape(ch.Name),
		)

		if ch.Icon != "" {
			attrs += fmt.Sprintf(
				` tvg-logo="%s"`,
				m3uEscape(ch.Icon),
			)
		}

		attrs += fmt.Sprintf(
			` group-title="%s"`,
			m3uEscape(ch.Group),
		)

		// Добавляем информацию об архиве.
		// channels.record хранит количество часов.
		if ch.Record > 0 {
			days := int(ch.Record) / 24

			if days > 0 {
				attrs += fmt.Sprintf(
					` catchup-days="%d" catchup-type="tvaplay"`,
					days,
				)
			}
		}

		fmt.Fprintf(
			bw,
			"#EXTINF:-1%s,%s\n",
			attrs,
			m3uEscape(ch.Name),
		)

		// Адрес источника из channels.udp.
		fmt.Fprintln(bw, ch.URL)
	}

	log.Printf(
		"[PLAYLIST] generated: user_id=%d channels=%d",
		user.ID,
		len(channels),
	)
}
