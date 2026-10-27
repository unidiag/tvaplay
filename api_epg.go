package main

import (
	"time"

	"main/models"
)

type epgNowProgramme struct {
	ID          uint64 `json:"id"`
	ChannelID   string `json:"channel_id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Start       int64  `json:"start"`
	Stop        int64  `json:"stop"`
	Rating      string `json:"rating"`
	Icon        string `json:"icon"`
}

func apiEPGNow(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	// Та же политика IP-доступа, что у плейлиста.
	if !isAllowedTVRequest(ctx.R) {
		out["status"] = "NOK"
		out["error"] = "Forbidden"
		return out
	}

	now := time.Now()

	var rows []models.EPGProgramme

	err := db.WithContext(ctx.R.Context()).
		Where("start <= ? AND stop > ?", now, now).
		Order("channel_id ASC, start DESC").
		Find(&rows).Error

	if err != nil {
		out["status"] = "NOK"
		out["error"] = "Database error"

		slog("EPG API database error: "+err.Error(), "error")
		return out
	}

	programmes := make(map[string]epgNowProgramme)

	for _, p := range rows {
		// При пересечении передач выбираем последнюю
		// по времени начала.
		if _, exists := programmes[p.ChannelID]; exists {
			continue
		}

		programmes[p.ChannelID] = epgNowProgramme{
			ID:          p.ID,
			ChannelID:   p.ChannelID,
			Title:       p.Title,
			Description: p.Description,
			Start:       p.Start.UnixMilli(),
			Stop:        p.Stop.UnixMilli(),
			Rating:      p.Rating,
			Icon:        p.Icon,
		}
	}

	out["server_time"] = now.UnixMilli()
	out["programmes"] = programmes

	return out
}
