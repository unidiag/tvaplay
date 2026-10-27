package models

import "time"

type User struct {
	ID               uint       `gorm:"primaryKey" json:"id"`
	Login            string     `gorm:"size:15;uniqueIndex;not null" json:"login"` // логин - номер телефона в формате 80297153616
	Password         string     `gorm:"size:255;not null" json:"-"`                // пароль сделаем всем одинаковый 1234 -- это не страшно, потому что идентификация по SMS-коду
	Status           uint       `gorm:"default:0" json:"status"`                   // 0 - неактивный, 1 - обычный оплаченный абонент, 2 - премиум абонент, 9 - админ
	MaxDev           uint       `gorm:"not null;default:1" json:"max_dev"`
	LastActive       time.Time  `json:"last_active"`
	LastIP           string     `gorm:"size:45" json:"last_ip"`
	LastUA           string     `gorm:"type:text" json:"last_ua"`
	LastCode         string     `gorm:"size:4" json:"last_code"` // последний отправленный пароль
	LastCodeSentAt   *time.Time `gorm:"index" json:"-"`
	LastCodeAttempts uint       `gorm:"default:0" json:"-"`
	LoginAt          time.Time  `json:"login_at"` // время подтверждения SMS-кода, посути время входа
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}
