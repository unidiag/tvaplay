package models

import "time"

// Типы операций с балансом.
const (
	BalanceDailyCharge = "daily_charge"
	BalancePauseFee    = "pause_fee"
	BalanceResumeFee   = "resume_fee"
	BalanceTopup       = "balance_topup"
	BalanceAdjustment  = "balance_adjustment"
	BalanceSet         = "balance_set"
	BalancePauseRefund = "pause_refund"
)

// BalanceTransaction — одна завершённая
// финансовая операция абонента.
type BalanceTransaction struct {
	ID uint64 `gorm:"primaryKey" json:"id"`

	UserID uint `gorm:"not null;index:idx_balance_user_created,priority:1" json:"user_id"`

	// Тип операции, используется фронтендом.
	Type string `gorm:"type:varchar(32);not null;index" json:"type"`

	// Изменение баланса:
	// отрицательное — списание,
	// положительное — зачисление.
	Amount string `gorm:"type:decimal(12,2);not null" json:"amount"`

	// Баланс после завершения операции.
	// NULL допустим для исторических записей,
	// перенесённых из старой таблицы.
	BalanceAfter *string `gorm:"type:decimal(12,2)" json:"balance_after"`

	// Уникальный идентификатор операции.
	// Не допускает повторного списания.
	OperationKey string `gorm:"type:varchar(128);not null;uniqueIndex:ux_balance_operation" json:"-"`

	// Сведения для ежедневного биллинга.
	ChargeDate   *time.Time `gorm:"type:date;index" json:"charge_date,omitempty"`
	MonthlyTotal *string    `gorm:"type:decimal(12,2)" json:"monthly_total,omitempty"`

	CreatedAt time.Time `gorm:"type:datetime(3);not null;index:idx_balance_user_created,priority:2" json:"created_at"`
}

func (BalanceTransaction) TableName() string {
	return "balance_transactions"
}
