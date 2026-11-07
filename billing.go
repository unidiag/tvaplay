package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"main/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// The TV service operates on Belarus local calendar days, irrespective of
// the host's timezone. Do not silently use time.Local or UTC here.
func billingLocation() (*time.Location, error) {
	return time.LoadLocation("Europe/Minsk")
}

func billingDay(t time.Time, location *time.Location) time.Time {
	y, m, d := t.In(location).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, location)
}

func billingDaysInMonth(day time.Time) int {
	return time.Date(
		day.Year(),
		day.Month()+1,
		0, 0, 0, 0, 0,
		day.Location(),
	).Day()
}

// startBillingWorker should be called only after GORM migrations have finished.
// It retries after failures and catches up today's charge after a restart.
// Each user's unique (user_id, charge_date) key prevents double debits.
func startBillingWorker(ctx context.Context) {
	location, err := billingLocation()
	if err != nil {
		log.Printf("[BILLING] timezone unavailable: %v", err)
		return
	}

	go func() {
		log.Printf("[BILLING] started; timezone=%s", location.String())
		for {
			now := time.Now().In(location)
			day := billingDay(now, location)
			if err := chargeDailyBalances(ctx, day); err != nil {
				log.Printf("[BILLING] charge date=%s failed: %v", day.Format("2006-01-02"), err)
				if !billingSleep(ctx, time.Minute) {
					return
				}
				continue
			}

			// Wake up at the next local midnight, not every few minutes.
			next := day.AddDate(0, 0, 1)
			if !billingSleep(ctx, time.Until(next)) {
				return
			}
		}
	}()
}

func billingSleep(ctx context.Context, duration time.Duration) bool {
	if duration < 0 {
		duration = 0
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// chargeDailyBalances charges accounts with positive balance and status 1..7.
// Users created after midnight are first eligible on the following day.
func chargeDailyBalances(ctx context.Context, day time.Time) error {
	var ids []uint
	if err := db.WithContext(ctx).
		Model(&models.User{}).
		Where("status > ? AND status < ? AND balance > ? AND created_at < ?", 0, 8, 0, day).
		Pluck("id", &ids).Error; err != nil {
		return fmt.Errorf("load eligible users: %w", err)
	}

	processed := 0
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return err
		}
		charged, err := chargeOneUser(ctx, id, day)
		if err != nil {
			// Continue other subscribers, but trigger the next retry cycle.
			log.Printf("[BILLING] user_id=%d: %v", id, err)
			return err
		}
		if charged {
			processed++
		}
	}
	log.Printf("[BILLING] date=%s users_charged=%d", day.Format("2006-01-02"), processed)
	return nil
}

func chargeOneUser(ctx context.Context, userID uint, day time.Time) (bool, error) {
	charged := false
	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var user models.User
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&user, userID).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}

		// The status and balance are checked again inside the transaction.
		if user.Status == 0 || user.Status >= 8 ||
			!user.CreatedAt.Before(day) {
			return nil
		}
		var balance struct{ Positive int }
		if err := tx.Raw("SELECT (balance > 0) AS positive FROM users WHERE id = ?", userID).
			Scan(&balance).Error; err != nil {
			return err
		}
		if balance.Positive != 1 {
			return nil
		}

		// Aggregate current enabled package prices. DISTINCT is unnecessary
		// because user_packages has a unique (user_id, package_id) relation.
		var sums struct {
			MonthlyTotal string `gorm:"column:monthly_total"`
			Amount       string `gorm:"column:amount"`
		}
		days := billingDaysInMonth(day)
		index := day.Day()
		err := tx.Raw(`
SELECT
    CAST(COALESCE(SUM(p.monthly_price), 0) AS CHAR) AS monthly_total,
    CAST(
       ROUND(COALESCE(SUM(p.monthly_price), 0) * ? / ?, 2) -
       ROUND(COALESCE(SUM(p.monthly_price), 0) * ? / ?, 2)
       AS CHAR
    ) AS amount
FROM user_packages up
JOIN packages p ON p.id = up.package_id
WHERE up.user_id = ? AND p.enabled = 1`,
			index, days, index-1, days, userID,
		).Scan(&sums).Error
		if err != nil {
			return err
		}
		if strings.TrimSpace(sums.Amount) == "" {
			return errors.New("invalid daily charge")
		}

		var positive struct{ Positive int }
		if err := tx.Raw("SELECT (CAST(? AS DECIMAL(12,2)) > 0) AS positive", sums.Amount).
			Scan(&positive).Error; err != nil {
			return err
		}
		if positive.Positive != 1 {
			return nil
		}

		ledger := models.DailyBalanceCharge{
			UserID:       userID,
			ChargeDate:   day,
			Amount:       sums.Amount,
			MonthlyTotal: sums.MonthlyTotal,
		}
		insert := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&ledger)
		if insert.Error != nil {
			return insert.Error
		}
		if insert.RowsAffected == 0 {
			return nil // Already charged for this local calendar day.
		}

		// Exact decimal subtraction in MySQL, never a float64 calculation.
		if err := tx.Model(&models.User{}).Where("id = ?", userID).
			UpdateColumn("balance", gorm.Expr("balance - CAST(? AS DECIMAL(12,2))", sums.Amount)).Error; err != nil {
			return err
		}
		charged = true
		return nil
	})
	return charged, err
}
