package models

import "time"

type UserRefreshToken struct {
	ID        uint      `gorm:"primaryKey"`
	UserID    uint      `gorm:"index;not null"`
	JTI       string    `gorm:"uniqueIndex;size:64;not null"`
	ExpiresAt time.Time `gorm:"index;not null"`
	UserAgent string    `gorm:"size:255"`
	IP        string    `gorm:"size:45"` // IPv4/IPv6
	CreatedAt time.Time
}
