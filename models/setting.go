package models

import "time"

type Setting struct {
	Key         string    `gorm:"primaryKey" json:"key"`
	Value       string    `json:"value"`
	LastValue   string    `json:"last_value"`
	Description string    `gorm:"type:text" json:"description"`
	Position    uint      `gorm:"default:0" json:"position"`
	UpdatedAt   time.Time `json:"updated_at"`
}
