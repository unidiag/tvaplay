package models

import "time"

type User struct {
	ID         uint      `gorm:"primaryKey" json:"id"`
	Login      string    `gorm:"size:100;uniqueIndex;not null" json:"login"`
	Password   string    `gorm:"size:255;not null" json:"-"`
	Status     uint      `gorm:"default:0" json:"status"`
	Token      string    `gorm:"size:32" json:"token"`
	LastActive time.Time `json:"last_active"`
	LastIP     string    `gorm:"size:45" json:"last_ip"`
	LastUA     string    `gorm:"type:text" json:"last_ua"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}
