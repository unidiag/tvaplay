package main

import (
	"main/models"
	"strconv"
	"strings"
)

// apiAdminViewStats returns at most 30 viewing records, newest first.
// Exactly one of user_id or session_id must be provided.
// session_id is the numeric user_refresh_tokens.id, NOT view_stats.session_id.
func apiAdminViewStats(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	userText := strings.TrimSpace(ctx.D["user_id"])
	sessionText := strings.TrimSpace(ctx.D["session_id"])
	if (userText == "") == (sessionText == "") {
		return adminUserError(ctx, "NOK", "Specify either user_id or session_id")
	}

	limit := 30
	if s := strings.TrimSpace(ctx.D["limit"]); s != "" {
		parsed, err := strconv.Atoi(s)
		if err != nil || parsed < 1 || parsed > 30 {
			return adminUserError(ctx, "NOK", "Invalid limit (1..30)")
		}
		limit = parsed
	}

	query := db.WithContext(ctx.R.Context()).Model(&models.ViewStat{})
	if userText != "" {
		userID, err := strconv.ParseUint(userText, 10, 32)
		if err != nil || userID == 0 {
			return adminUserError(ctx, "NOK", "Invalid user_id")
		}
		query = query.Where("user_id = ?", userID)
	} else {
		authSessionID, err := strconv.ParseUint(sessionText, 10, 64)
		if err != nil || authSessionID == 0 {
			return adminUserError(ctx, "NOK", "Invalid session_id")
		}

		// Distinct from the playback UUID stored in view_stats.session_id.
		// Requires auth_session_id to be persisted by the viewing tracker.
		var session struct {
			ID     uint64 `gorm:"column:id"`
			UserID uint32 `gorm:"column:user_id"`
		}
		result := db.WithContext(ctx.R.Context()).Table("user_refresh_tokens").
			Select("id, user_id").Where("id = ?", authSessionID).Take(&session)
		if result.Error != nil {
			return adminUserError(ctx, "NOK", "Session not found")
		}
		query = query.Where("user_id = ? AND auth_session_id = ?", session.UserID, session.ID)
	}

	var stats []models.ViewStat
	if err := query.Order("started_at DESC, id DESC").Limit(limit).Find(&stats).Error; err != nil {
		return adminUserError(ctx, "NOK", "Cannot load viewing statistics")
	}
	if stats == nil {
		stats = []models.ViewStat{}
	}

	// Resolve channel names and EPG IDs only for the selected viewing records.
	channelNames := make(map[uint32]string)
	channelIcons := make(map[uint32]string)
	if len(stats) > 0 {
		channelIDs := make([]uint32, 0, len(stats))
		for _, item := range stats {
			channelIDs = append(channelIDs, item.ChannelID)
		}

		var channels []models.Channel
		if err := db.WithContext(ctx.R.Context()).Model(&models.Channel{}).
			Select("id, name, epgid").Where("id IN ?", channelIDs).
			Find(&channels).Error; err != nil {
			return adminUserError(ctx, "NOK", "Cannot load channels")
		}

		epgIDs := make([]string, 0, len(channels))
		for _, channel := range channels {
			channelNames[channel.ID] = channel.Name
			if id := strings.TrimSpace(channel.EPGID); id != "" {
				epgIDs = append(epgIDs, id)
			}
		}

		if len(epgIDs) > 0 {
			var epgChannels []models.EPGChannel
			if err := db.WithContext(ctx.R.Context()).Model(&models.EPGChannel{}).
				Select("id, icon").Where("id IN ?", epgIDs).
				Find(&epgChannels).Error; err != nil {
				return adminUserError(ctx, "NOK", "Cannot load channel icons")
			}

			epgIcons := make(map[string]string, len(epgChannels))
			for _, epg := range epgChannels {
				epgIcons[epg.ID] = strings.TrimSpace(epg.Icon)
			}
			for _, channel := range channels {
				channelIcons[channel.ID] = epgIcons[strings.TrimSpace(channel.EPGID)]
			}
		}
	}

	// Resolve EPG programme titles in one query for the selected records.
	programmeTitles := make(map[uint64]string)
	programmeIDs := make([]uint64, 0, len(stats))
	for _, item := range stats {
		if item.ProgrammeID != nil {
			programmeIDs = append(programmeIDs, *item.ProgrammeID)
		}
	}
	if len(programmeIDs) > 0 {
		var programmes []struct {
			ID    uint64 `gorm:"column:id"`
			Title string `gorm:"column:title"`
		}
		if err := db.WithContext(ctx.R.Context()).Table("epg_programmes").
			Select("id, title").Where("id IN ?", programmeIDs).
			Scan(&programmes).Error; err != nil {
			return adminUserError(ctx, "NOK", "Cannot load EPG programmes")
		}
		for _, programme := range programmes {
			programmeTitles[programme.ID] = programme.Title
		}
	}

	// Определение страны по IP-адресу.
	// Кешируем результат, чтобы не искать один IP несколько раз.
	ipCountries := make(map[string]string)

	for _, item := range stats {
		if item.IPAddress == nil {
			continue
		}

		ip := strings.TrimSpace(*item.IPAddress)
		if ip == "" {
			continue
		}

		if _, exists := ipCountries[ip]; exists {
			continue
		}

		// Здесь нужно вызвать существующую функцию GeoIP из TVAPLAY.
		// Она должна возвращать ISO-код страны: BY, RU, DE и т.д.
		ipCountries[ip] = geoIP(ip)
	}

	rows := make([]map[string]any, 0, len(stats))

	for _, item := range stats {
		programmeTitle := ""
		if item.ProgrammeID != nil {
			programmeTitle = programmeTitles[*item.ProgrammeID]
		}

		country := ""
		if item.IPAddress != nil {
			country = ipCountries[strings.TrimSpace(*item.IPAddress)]
		}
		if item.ProgrammeID != nil {
			programmeTitle = programmeTitles[*item.ProgrammeID]
		}
		rows = append(rows, map[string]any{
			"id":              item.ID,
			"channel_id":      item.ChannelID,
			"channel_name":    channelNames[item.ChannelID],
			"channel_icon":    channelIcons[item.ChannelID],
			"user_id":         item.UserID,
			"view_type":       item.ViewType,
			"programme_id":    item.ProgrammeID,
			"programme_title": programmeTitle,
			"session_id":      item.SessionID,
			"ip_address":      item.IPAddress,
			"started_at":      item.StartedAt,
			"last_seen_at":    item.LastSeenAt,
			"ended_at":        item.EndedAt,
			"duration_sec":    item.DurationSec,
			"country":         country,
		})
	}
	ctx.Out["stats"] = rows
	ctx.Out["total"] = len(rows)
	ctx.W.Header().Set("Cache-Control", "no-store")
	return ctx.Out
}
