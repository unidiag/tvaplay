package models

import "time"

type UserRefreshToken struct {
	ID        uint      `gorm:"primaryKey"`
	UserID    uint      `gorm:"index;not null"`
	JTI       string    `gorm:"uniqueIndex;size:64;not null"`
	UID       string    `gorm:"size:36;not null;index"`
	UserAgent string    `gorm:"size:255"`
	IP        string    `gorm:"size:45"` // IPv4/IPv6
	ExpiresAt time.Time `gorm:"index;not null"`
	CreatedAt time.Time
}
