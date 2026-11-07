package models

import "time"

// DailyBalanceCharge records a single successful daily debit per user.
// The compound unique index makes retries and concurrent workers idempotent.
type DailyBalanceCharge struct {
	ID           uint      `gorm:"primaryKey"`
	UserID       uint      `gorm:"not null;uniqueIndex:ux_daily_balance_user_date"`
	ChargeDate   time.Time `gorm:"type:date;not null;uniqueIndex:ux_daily_balance_user_date"`
	Amount       string    `gorm:"type:decimal(12,2);not null"`
	MonthlyTotal string    `gorm:"type:decimal(12,2);not null"`
	CreatedAt    time.Time
}

func (DailyBalanceCharge) TableName() string { return "daily_balance_charges" }
