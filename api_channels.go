package main

import (
	"errors"
	"fmt"
	"main/models"
	"strconv"
	"strings"

	"gorm.io/gorm"
)

type adminChannelRow struct {
	models.Channel
	Icon    string `json:"icon"`
	EPGName string `json:"epg_name"`
}

func requireChannelAdmin(ctx *ApiCtx) bool {
	if ctx.User != nil && ctx.User.Status >= 8 {
		return true
	}

	ctx.Out["status"] = "FORBIDDEN"
	ctx.Out["message"] = "Administrator access required"
	return false
}

func channelError(ctx *ApiCtx, message string) map[string]any {
	ctx.Out["status"] = "NOK"
	ctx.Out["message"] = message
	return ctx.Out
}

func parseChannelID(s string) (uint32, error) {
	n, err := strconv.ParseUint(strings.TrimSpace(s), 10, 32)
	if err != nil || n == 0 {
		return 0, errors.New("invalid channel ID")
	}
	return uint32(n), nil
}

// Загружает каналы вместе с EPG-иконками.
func loadAdminChannels() ([]adminChannelRow, error) {
	var channels []models.Channel

	if err := db.
		Order("position ASC, id ASC").
		Find(&channels).Error; err != nil {
		return nil, err
	}

	var epg []models.EPGChannel
	if err := db.Select("id", "name", "icon").
		Find(&epg).Error; err != nil {
		return nil, err
	}

	epgByID := make(map[string]models.EPGChannel, len(epg))
	for _, item := range epg {
		epgByID[item.ID] = item
	}

	rows := make([]adminChannelRow, 0, len(channels))

	for _, ch := range channels {
		row := adminChannelRow{Channel: ch}

		if e, ok := epgByID[ch.EPGID]; ok {
			row.Icon = e.Icon
			row.EPGName = e.Name
		}
		rows = append(rows, row)
	}

	return rows, nil
}

// POST {"op":"adminChannels"}
func apiAdminChannels(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	rows, err := loadAdminChannels()
	if err != nil {
		return channelError(ctx, "Cannot load channels")
	}

	ctx.Out["channels"] = rows
	return ctx.Out
}

// POST {"op":"adminEPGChannels"}
func apiAdminEPGChannels(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	var rows []models.EPGChannel

	err := db.Select("id", "name", "icon").
		Order("name ASC").
		Find(&rows).Error

	if err != nil {
		return channelError(ctx, "Cannot load EPG channels")
	}

	ctx.Out["channels"] = rows
	return ctx.Out
}

//	POST {
//	  "op":"adminChannelSave",
//	  "id":0,
//	  "name":"Первый канал",
//	  "udp":"udp://239.0.0.1:1234",
//	  "record":0,
//	  "enable":1,
//	  "epgid":""
//	}
func apiAdminChannelSave(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	name := strings.TrimSpace(ctx.D["name"])
	udp := strings.TrimSpace(ctx.D["udp"])
	epgid := strings.TrimSpace(ctx.D["epgid"])

	if name == "" || len(name) > 255 {
		return channelError(ctx, "Invalid channel name")
	}
	if udp == "" || len(udp) > 255 {
		return channelError(ctx, "Invalid UDP address")
	}
	if len(epgid) > 64 {
		return channelError(ctx, "EPG ID is too long")
	}

	record64, err := strconv.ParseUint(ctx.D["record"], 10, 16)
	if err != nil {
		return channelError(ctx, "Invalid record hours")
	}

	enable64, err := strconv.ParseUint(ctx.D["enable"], 10, 8)
	if err != nil || enable64 > 1 {
		return channelError(ctx, "Invalid enable value")
	}

	if epgid != "" {
		var count int64
		if err := db.Model(&models.EPGChannel{}).
			Where("id = ?", epgid).
			Count(&count).Error; err != nil {
			return channelError(ctx, "EPG lookup failed")
		}
		if count == 0 {
			return channelError(ctx, "EPG channel not found")
		}
	}

	idText := strings.TrimSpace(ctx.D["id"])
	var id uint32

	if idText != "" && idText != "0" {
		id, err = parseChannelID(idText)
		if err != nil {
			return channelError(ctx, "Invalid channel ID")
		}
	}

	values := map[string]any{
		"name":   name,
		"udp":    udp,
		"record": uint16(record64),
		"enable": uint8(enable64),
		"epgid":  epgid,
	}

	var saved models.Channel

	err = db.Transaction(func(tx *gorm.DB) error {
		if id != 0 {
			if err := tx.First(&saved, id).Error; err != nil {
				return err
			}
			return tx.Model(&saved).Updates(values).Error
		}

		var maxPosition uint16
		if err := tx.Model(&models.Channel{}).
			Select("COALESCE(MAX(position), 0)").
			Scan(&maxPosition).Error; err != nil {
			return err
		}
		if maxPosition == ^uint16(0) {
			return errors.New("channel position limit reached")
		}

		saved = models.Channel{
			Name:     name,
			UDP:      udp,
			Record:   uint16(record64),
			Enable:   uint8(enable64),
			EPGID:    epgid,
			Position: maxPosition + 1,
		}
		return tx.Create(&saved).Error
	})

	if errors.Is(err, gorm.ErrRecordNotFound) {
		return channelError(ctx, "Channel not found")
	}
	if err != nil {
		return channelError(ctx, "Cannot save channel")
	}

	ctx.Out["id"] = saved.ID
	return ctx.Out
}

// POST {"op":"adminChannelDelete","id":12}
func apiAdminChannelDelete(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	id, err := parseChannelID(ctx.D["id"])
	if err != nil {
		return channelError(ctx, "Invalid channel ID")
	}

	err = db.Transaction(func(tx *gorm.DB) error {
		result := tx.Delete(&models.Channel{}, id)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return nil
	})
	if err != nil {
		return channelError(ctx, "Cannot delete channel")
	}

	return ctx.Out
}

//	POST {
//	  "op":"adminChannelsOrder",
//	  "ids":[3,1,2]
//	}
func apiAdminChannelsOrder(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	raw, ok := ctx.Data["ids"].([]any)
	if !ok || len(raw) == 0 || len(raw) > 65535 {
		return channelError(ctx, "Invalid channels order")
	}

	ids := make([]uint32, 0, len(raw))
	seen := make(map[uint32]bool)

	for _, v := range raw {
		id, err := parseChannelID(fmt.Sprint(v))
		if err != nil || seen[id] {
			return channelError(ctx, "Duplicate or invalid channel ID")
		}
		seen[id] = true
		ids = append(ids, id)
	}

	err := db.Transaction(func(tx *gorm.DB) error {
		var existing []uint32

		if err := tx.Model(&models.Channel{}).
			Order("id ASC").
			Pluck("id", &existing).Error; err != nil {
			return err
		}

		// Требуем полный список, а не его часть.
		if len(existing) != len(ids) {
			return errors.New("channel list changed")
		}
		for _, existingID := range existing {
			if !seen[existingID] {
				return errors.New("channel list changed")
			}
		}

		for i, id := range ids {
			result := tx.Model(&models.Channel{}).
				Where("id = ?", id).
				Update("position", i+1)
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected == 0 {
				return errors.New("channel list changed")
			}
		}
		return nil
	})

	if err != nil {
		return channelError(ctx, "Cannot update channels order: "+err.Error())
	}

	return ctx.Out
}
