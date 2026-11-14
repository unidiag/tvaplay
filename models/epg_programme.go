package models

import "time"

type EPGProgramme struct {
	ID          uint64    `gorm:"primaryKey;autoIncrement" json:"id"`
	EPGID       string    `gorm:"size:64" json:"epg_id"`
	ChannelID   string    `gorm:"size:64;not null;uniqueIndex:idx_epg_channel_start" json:"channel_id"`
	Start       time.Time `gorm:"not null;uniqueIndex:idx_epg_channel_start;index:idx_epg_start" json:"start"`
	Stop        time.Time `gorm:"not null;index:idx_epg_stop" json:"stop"`
	Title       string    `gorm:"size:512" json:"title"`
	Description string    `gorm:"type:longtext" json:"description"`
	Categories  string    `gorm:"type:json" json:"categories"`
	Country     string    `gorm:"size:255" json:"country"`
	Icon        string    `gorm:"type:text" json:"icon"`
	Rating      string    `gorm:"size:32" json:"rating"`
	Date        string    `gorm:"size:32" json:"date"`
	DataURL     string    `gorm:"type:text" json:"data_url"`
	SyncedAt    int64     `gorm:"not null;index:idx_epg_synced" json:"-"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}
