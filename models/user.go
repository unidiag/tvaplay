package models

import "time"

type User struct {
	ID        uint   `gorm:"primaryKey" json:"id"`
	BillingID uint64 `gorm:"column:billing_id;not null;default:0;index:ux_users_billing_id_positive,unique,expression:NULLIF(billing_id, 0)" json:"billing_id"`
	Login     string `gorm:"size:15;uniqueIndex;not null" json:"login"`
	Password  string `gorm:"size:255;not null" json:"-"`

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

	// Текущий IP, с которого разрешён IPTV-просмотр.
	HomeIP string `gorm:"column:home_ip;size:45;not null;default:''" json:"-"`
	// Последняя подтверждённая активность просмотра
	// с текущего домашнего IP.
	HomeIPSeenAt *time.Time `gorm:"column:home_ip_seen_at;type:datetime(3)" json:"-"`
	// Последняя смена домашнего IP.
	HomeIPChangedAt *time.Time `gorm:"column:home_ip_changed_at;type:datetime(3)" json:"-"`

	// Последняя самостоятельная постановка услуги на паузу.
	// Используется для ограничения: один раз в календарный месяц.
	LastPausedAt *time.Time `gorm:"column:last_paused_at" json:"-"`
	LoginAt      *time.Time `json:"login_at"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`

	// Administrative grouping only; no access checks are changed in this stage.
	Packages []Package `gorm:"many2many:user_packages;joinForeignKey:UserID;joinReferences:PackageID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`
}
