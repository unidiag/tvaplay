package main

import (
	"main/models"
	"strconv"
	"strings"
	"time"
)

type ChannelStatistics struct {
	ChannelID     uint32 `json:"channel_id"`
	ChannelName   string `json:"channel_name"`
	Views         int64  `json:"views"`
	UniqueViewers int64  `json:"unique_viewers"`
	LiveViews     int64  `json:"live_views"`
	ArchiveViews  int64  `json:"archive_views"`
	DurationSec   int64  `json:"duration_sec"`
}

func apiAdminStatistics(ctx *ApiCtx) map[string]any {
	period := strings.TrimSpace(ctx.D["period"])
	if period == "" {
		period = "7"
	}

	now := time.Now()
	var since *time.Time

	switch period {
	case "1":
		start := time.Date(
			now.Year(), now.Month(), now.Day(),
			0, 0, 0, 0, now.Location(),
		)
		since = &start
	case "7":
		start := now.AddDate(0, 0, -7)
		since = &start
	case "30":
		start := now.AddDate(0, 0, -30)
		since = &start
	case "all":
		// Без ограничения по дате.
	default:
		ctx.Out["status"] = "NOK"
		ctx.Out["message"] = "Invalid period"
		return ctx.Out
	}

	viewType := strings.TrimSpace(ctx.D["view_type"])
	if viewType == "" {
		viewType = "all"
	}
	if viewType != "all" &&
		viewType != "live" &&
		viewType != "archive" {
		ctx.Out["status"] = "NOK"
		ctx.Out["message"] = "Invalid view type"
		return ctx.Out
	}

	query := db.Model(&models.Channel{}).
		Table("channels AS c")

	join := "LEFT JOIN view_stats AS v ON v.channel_id = c.id"
	args := make([]any, 0, 2)

	if since != nil {
		join += " AND v.started_at >= ?"
		args = append(args, *since)
	}

	if viewType != "all" {
		join += " AND v.view_type = ?"
		args = append(args, viewType)
	}

	query = query.Joins(join, args...).
		Select(`
			c.id AS channel_id,
			c.name AS channel_name,
			COUNT(v.id) AS views,
			COUNT(DISTINCT v.user_id) AS unique_viewers,
			COALESCE(SUM(
				CASE WHEN v.view_type = 'live'
				THEN 1 ELSE 0 END
			), 0) AS live_views,
			COALESCE(SUM(
				CASE WHEN v.view_type = 'archive'
				THEN 1 ELSE 0 END
			), 0) AS archive_views,
			COALESCE(SUM(v.duration_sec), 0) AS duration_sec
		`).
		Group("c.id, c.name").
		Order("duration_sec DESC, views DESC, c.name ASC")

	items := make([]ChannelStatistics, 0)
	if err := query.Scan(&items).Error; err != nil {
		ctx.Out["status"] = "NOK"
		ctx.Out["message"] = "Cannot load statistics"
		return ctx.Out
	}

	var totalViews int64
	var totalDuration int64

	for _, item := range items {
		totalViews += item.Views
		totalDuration += item.DurationSec
	}

	// Уникальных зрителей по всей платформе считаем отдельно,
	// чтобы не суммировать их по каналам.
	uniqueQuery := db.Model(&models.ViewStat{})

	if since != nil {
		uniqueQuery = uniqueQuery.Where(
			"started_at >= ?", *since,
		)
	}
	if viewType != "all" {
		uniqueQuery = uniqueQuery.Where(
			"view_type = ?", viewType,
		)
	}

	var totalViewers int64
	if err := uniqueQuery.
		Distinct("user_id").
		Count(&totalViewers).Error; err != nil {
		ctx.Out["status"] = "NOK"
		ctx.Out["message"] = "Cannot load viewer count"
		return ctx.Out
	}

	ctx.Out["channels"] = items
	ctx.Out["period"] = period
	ctx.Out["view_type"] = viewType
	ctx.Out["total_views"] = totalViews
	ctx.Out["total_viewers"] = totalViewers
	ctx.Out["total_duration_sec"] = totalDuration

	return ctx.Out
}

// ██████╗ ██████╗  ██████╗  ██████╗ ██████╗  █████╗ ███╗   ███╗███╗   ███╗███████╗
// ██╔══██╗██╔══██╗██╔═══██╗██╔════╝ ██╔══██╗██╔══██╗████╗ ████║████╗ ████║██╔════╝
// ██████╔╝██████╔╝██║   ██║██║  ███╗██████╔╝███████║██╔████╔██║██╔████╔██║█████╗
// ██╔═══╝ ██╔══██╗██║   ██║██║   ██║██╔══██╗██╔══██║██║╚██╔╝██║██║╚██╔╝██║██╔══╝
// ██║     ██║  ██║╚██████╔╝╚██████╔╝██║  ██║██║  ██║██║ ╚═╝ ██║██║ ╚═╝ ██║███████╗
// ╚═╝     ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝     ╚═╝╚══════╝

type ProgrammeStatistics struct {
	Title         string `json:"title"`
	Views         int64  `json:"views"`
	UniqueViewers int64  `json:"unique_viewers"`
	LiveViews     int64  `json:"live_views"`
	ArchiveViews  int64  `json:"archive_views"`
	DurationSec   int64  `json:"duration_sec"`
}

func apiAdminProgrammeStatistics(ctx *ApiCtx) map[string]any {
	channelID, err := strconv.ParseUint(
		strings.TrimSpace(ctx.D["channel_id"]), 10, 32,
	)
	if err != nil || channelID == 0 {
		return settingAPIError(ctx, "Invalid channel ID")
	}

	var channel models.Channel
	if err := db.First(&channel, channelID).Error; err != nil {
		return settingAPIError(ctx, "Channel not found")
	}

	period := strings.TrimSpace(ctx.D["period"])
	if period == "" {
		period = "7"
	}

	viewType := strings.TrimSpace(ctx.D["view_type"])
	if viewType == "" {
		viewType = "all"
	}
	if viewType != "all" &&
		viewType != "live" &&
		viewType != "archive" {
		return settingAPIError(ctx, "Invalid view type")
	}

	now := time.Now()
	var since *time.Time

	switch period {
	case "1":
		start := time.Date(
			now.Year(), now.Month(), now.Day(),
			0, 0, 0, 0, now.Location(),
		)
		since = &start

	case "7":
		start := now.AddDate(0, 0, -7)
		since = &start

	case "30":
		start := now.AddDate(0, 0, -30)
		since = &start

	case "all":
		// Без ограничения по времени.

	default:
		return settingAPIError(ctx, "Invalid period")
	}

	// Общие параметры для Live и Archive.
	// Фильтрация периода соответствует рейтингу каналов:
	// учитываются сессии, начавшиеся в выбранный период.
	sessionFilter := "v.channel_id = ? AND v.duration_sec > 0"
	filterArgs := []any{channel.ID}

	if since != nil {
		sessionFilter += " AND v.started_at >= ?"
		filterArgs = append(filterArgs, *since)
	}

	// Live: вычисляем пересечение фактического интервала
	// просмотра с каждым интервалом программы EPG.
	liveSQL := `
		SELECT
			p.title AS title,
			v.id AS session_id,
			v.user_id AS user_id,
			'live' AS view_type,
			GREATEST(
				0,
				TIMESTAMPDIFF(
					SECOND,
					GREATEST(v.started_at, p.start),
					LEAST(
						TIMESTAMPADD(
							SECOND,
							v.duration_sec,
							v.started_at
						),
						p.stop
					)
				)
			) AS watched_sec
		FROM view_stats v
		INNER JOIN channels c
			ON c.id = v.channel_id
		INNER JOIN epg_programmes p
			ON p.channel_id COLLATE utf8mb4_unicode_ci = c.epgid COLLATE utf8mb4_unicode_ci
			AND p.start < TIMESTAMPADD(
				SECOND,
				v.duration_sec,
				v.started_at
			)
			AND p.stop > v.started_at
		WHERE ` + sessionFilter + `
			AND v.view_type = 'live'
			AND p.stop > p.start
	`

	// Archive: привязка к программе через programme_id.
	// Время просмотра берём из duration_sec.
	archiveSQL := `
		SELECT
			p.title AS title,
			v.id AS session_id,
			v.user_id AS user_id,
			'archive' AS view_type,
			v.duration_sec AS watched_sec
		FROM view_stats v
		INNER JOIN epg_programmes p
			ON p.id = v.programme_id
		INNER JOIN channels c
			ON c.id = v.channel_id
			AND p.channel_id COLLATE utf8mb4_unicode_ci = c.epgid COLLATE utf8mb4_unicode_ci
		WHERE ` + sessionFilter + `
			AND v.view_type = 'archive'
	`

	var parts []string
	var args []any

	if viewType == "all" || viewType == "live" {
		parts = append(parts, liveSQL)
		args = append(args, filterArgs...)
	}
	if viewType == "all" || viewType == "archive" {
		parts = append(parts, archiveSQL)
		args = append(args, filterArgs...)
	}

	// Группируем по названию программы.
	// Одна и та же передача может выходить несколько раз.
	query := `
		SELECT
			title,
			COUNT(DISTINCT session_id) AS views,
			COUNT(DISTINCT user_id) AS unique_viewers,
			COUNT(DISTINCT CASE
				WHEN view_type = 'live'
				THEN session_id
			END) AS live_views,
			COUNT(DISTINCT CASE
				WHEN view_type = 'archive'
				THEN session_id
			END) AS archive_views,
			COALESCE(SUM(watched_sec), 0) AS duration_sec
		FROM (
			` + strings.Join(parts, "\nUNION ALL\n") + `
		) AS viewing
		WHERE watched_sec > 0
			AND title <> ''
		GROUP BY title
		ORDER BY duration_sec DESC, views DESC, title ASC
		LIMIT 30
	`

	items := make([]ProgrammeStatistics, 0)

	if err := db.Raw(query, args...).Scan(&items).Error; err != nil {
		return settingAPIError(ctx, "Cannot load programme statistics")
	}

	var totalViews, totalDuration int64
	for _, item := range items {
		totalViews += item.Views
		totalDuration += item.DurationSec
	}

	ctx.Out["channel_id"] = channel.ID
	ctx.Out["channel_name"] = channel.Name
	ctx.Out["programmes"] = items
	ctx.Out["total_views"] = totalViews
	ctx.Out["total_duration_sec"] = totalDuration
	ctx.Out["period"] = period
	ctx.Out["view_type"] = viewType

	return ctx.Out
}
