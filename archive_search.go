package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"main/models"
)

// GET /api/archive/search?q=Новости&channel_id=82&limit=100
// Only completed EPG programmes on enabled recorded channels are searchable.
// A two-hour retention guard is applied independently for each channel.
func serveArchiveSearch(w http.ResponseWriter, r *http.Request) {
	setDevCORS(w, r)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		if debug && w.Header().Get("Access-Control-Allow-Origin") != "" {
			w.WriteHeader(http.StatusNoContent)
		} else {
			http.Error(w, "Forbidden", http.StatusForbidden)
		}
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		archiveJSONError(w, http.StatusMethodNotAllowed, "METHOD_NOT_ALLOWED", "Требуется GET")
		return
	}
	user, err := getAuthUser(r)
	if err != nil || user == nil {
		archiveJSONError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Требуется авторизация")
		return
	}
	if !archiveStorageReady() {
		archiveJSONError(w, http.StatusServiceUnavailable, "ARCHIVE_UNAVAILABLE", "Архив недоступен")
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(q)) > 100 {
		archiveJSONError(w, http.StatusBadRequest, "INVALID_QUERY", "Поисковый запрос слишком длинный")
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 100 {
			archiveJSONError(w, http.StatusBadRequest, "INVALID_LIMIT", "Лимит: от 1 до 100")
			return
		}
		limit = n
	}
	var selectedID uint64
	if raw := r.URL.Query().Get("channel_id"); raw != "" {
		selectedID, err = strconv.ParseUint(raw, 10, 32)
		if err != nil || selectedID == 0 {
			archiveJSONError(w, http.StatusBadRequest, "INVALID_CHANNEL", "Неверный ID телеканала")
			return
		}
	}

	var channels []models.Channel

	// Загружаем логотипы телеканалов из EPGChannel.
	var epgChannels []models.EPGChannel

	if err := db.WithContext(r.Context()).
		Model(&models.EPGChannel{}).
		Select("id", "icon").
		Find(&epgChannels).Error; err != nil {

		archiveJSONError(
			w,
			http.StatusInternalServerError,
			"DB_ERROR",
			"Ошибка загрузки логотипов телеканалов",
		)
		return
	}

	// Карта: EPG ID -> URL логотипа.
	logos := make(map[string]string, len(epgChannels))

	for _, c := range epgChannels {
		logos[c.ID] = c.Icon
	}

	// Загружаем только каналы из активных пакетов пользователя,
	// для которых включена запись архива.
	query := db.WithContext(r.Context()).
		Model(&models.Channel{}).
		Where("channels.enable = ? AND channels.record > ?", 1, 2).
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
    `, user.ID)

	if err := query.
		Order("channels.id ASC").
		Find(&channels).Error; err != nil {

		archiveJSONError(
			w,
			http.StatusInternalServerError,
			"DB_ERROR",
			"Ошибка загрузки каналов",
		)
		return
	}

	type channelInfo struct {
		ID          uint32 `json:"id"`
		Name        string `json:"name"`
		EPGID       string `json:"epg_id"`
		RecordHours int64  `json:"record_hours"`
		Logo        string `json:"logo"`
	}
	channelList := make([]channelInfo, 0, len(channels))
	byEPG := make(map[string]models.Channel)
	for _, c := range channels {
		epg := strings.TrimSpace(c.EPGID)
		if epg == "" {
			continue
		}
		channelList = append(channelList, channelInfo{
			ID:          c.ID,
			Name:        c.Name,
			EPGID:       epg,
			RecordHours: int64(c.Record),
			Logo:        logos[epg],
		})
		if selectedID != 0 && uint64(c.ID) != selectedID {
			continue
		}
		// A shared EPG id can belong to multiple physical channels.
		// Select the channel with the longest available archive.
		if existing, ok := byEPG[epg]; !ok || c.Record > existing.Record {
			byEPG[epg] = c
		}
	}
	sort.Slice(channelList, func(i, j int) bool {
		return strings.ToLower(channelList[i].Name) < strings.ToLower(channelList[j].Name)
	})

	type programmeInfo struct {
		ID          uint64 `json:"id"`
		ChannelID   uint32 `json:"channel_id"`
		ChannelName string `json:"channel_name"`
		ChannelLogo string `json:"channel_logo"`
		EPGID       string `json:"epg_id"`
		Title       string `json:"title"`
		Description string `json:"description"`
		Start       int64  `json:"start"`
		Stop        int64  `json:"stop"`
		Icon        string `json:"icon"`
		Rating      string `json:"rating"`
	}
	result := make([]programmeInfo, 0)
	// Empty query is used to populate the channel filter without scanning EPG.
	if len([]rune(q)) >= 2 && len(byEPG) > 0 {
		now := time.Now()
		clauses := make([]string, 0, len(byEPG))
		args := make([]any, 0, 2*len(byEPG))
		for epg, c := range byEPG {
			cutoff := now.Add(-time.Duration(c.Record-2) * time.Hour)
			clauses = append(clauses, "(channel_id = ? AND start >= ?)")
			args = append(args, epg, cutoff)
		}
		// Escape wildcard characters so a user searches for literal text.
		escaped := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(q)
		var programmes []models.EPGProgramme
		err := db.WithContext(r.Context()).Model(&models.EPGProgramme{}).
			Where("("+strings.Join(clauses, " OR ")+")", args...).
			Where("stop <= ? AND stop > start", now).
			Where("title LIKE ? ESCAPE '!'", "%"+escaped+"%").
			Order("start DESC").Limit(limit).
			Find(&programmes).Error
		if err != nil {
			archiveJSONError(w, http.StatusInternalServerError, "DB_ERROR", "Ошибка поиска передач")
			return
		}
		for _, p := range programmes {
			c, ok := byEPG[p.ChannelID]
			if !ok {
				continue
			}
			result = append(result, programmeInfo{
				ID:          uint64(p.ID),
				ChannelID:   c.ID,
				ChannelName: c.Name,
				ChannelLogo: logos[p.ChannelID],
				EPGID:       p.ChannelID,
				Title:       p.Title,
				Description: p.Description,
				Icon:        p.Icon,
				Rating:      p.Rating,
				Start:       p.Start.UnixMilli(),
				Stop:        p.Stop.UnixMilli(),
			})
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": "OK", "channels": channelList, "programmes": result,
		"count": len(result), "retention_margin_hours": 2,
	})
}
