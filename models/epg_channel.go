package models

import "time"

type EPGChannel struct {
	ID        string    `gorm:"primaryKey;size:64" json:"id"`
	Name      string    `gorm:"size:255;not null" json:"name"`
	Icon      string    `gorm:"type:text" json:"icon"`
	Category  string    `gorm:"size:64;index" json:"category"`
	UpdatedAt time.Time `json:"updated_at"`
}
