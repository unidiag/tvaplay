package models

import "time"

type User struct {
	ID       uint   `gorm:"primaryKey" json:"id"`
	Login    string `gorm:"size:15;uniqueIndex;not null" json:"login"`
	Password string `gorm:"size:255;not null" json:"-"`

	Info    string `gorm:"column:info;type:text" json:"info"`
	Balance string `gorm:"column:balance;type:decimal(12,2);not null;default:0.00" json:"balance"`

	Status           uint       `gorm:"default:1" json:"status"`
	MaxDev           uint       `gorm:"not null;default:1" json:"max_dev"`
	LastActive       *time.Time `json:"last_active"`
	LastIP           string     `gorm:"size:45" json:"last_ip"`
	LastUA           string     `gorm:"type:text" json:"last_ua"`
	LastCode         string     `gorm:"size:4" json:"last_code"`
	LastCodeSentAt   *time.Time `gorm:"index" json:"-"`
	LastCodeAttempts uint       `gorm:"default:0" json:"-"`
	LoginAt          *time.Time `json:"login_at"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`

	// Administrative grouping only; no access checks are changed in this stage.
	Packages []Package `gorm:"many2many:user_packages;joinForeignKey:UserID;joinReferences:PackageID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`
}
