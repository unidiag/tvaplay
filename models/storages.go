package models

import "time"

// Storage is a configured directory for TV archive recordings.
type Storage struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Name      string    `gorm:"size:255;not null" json:"name"`
	Path      string    `gorm:"size:512;not null;uniqueIndex:ux_storages_path" json:"path"`
	Enabled   bool      `gorm:"not null;default:true" json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
