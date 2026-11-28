package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"main/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// The TV service operates on Belarus local calendar days,
// irrespective of the host's timezone.
// Do not silently use time.Local or UTC here.
func billingLocation() (*time.Location, error) {
	return time.LoadLocation("Europe/Minsk")
}

func billingDay(t time.Time, location *time.Location) time.Time {
	y, m, d := t.In(location).Date()

	return time.Date(
		y, m, d,
		0, 0, 0, 0,
		location,
	)
}

func billingDaysInMonth(day time.Time) int {
	return time.Date(
		day.Year(),
		day.Month()+1,
		0, 0, 0, 0, 0,
		day.Location(),
	).Day()
}

// Возвращает скидку в процентах.
// Допустимые значения: от 0 до 100.
func billingDiscount() (int, error) {
	value := strings.TrimSpace(
		getSetting("discount"),
	)

	discount, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf(
			"invalid billing discount %q: %w",
			value,
			err,
		)
	}

	if discount < 0 || discount > 100 {
		return 0, fmt.Errorf(
			"billing discount out of range: %d",
			discount,
		)
	}

	return discount, nil
}

// startBillingWorker запускается после завершения
// миграций GORM.
//
// При ошибках повторяет попытку через минуту.
//
// После перезапуска проверяет списания за текущий день.
//
// Уникальный operation_key предотвращает повторное
// списание за один календарный день.
func startBillingWorker(ctx context.Context) {
	location, err := billingLocation()
	if err != nil {
		log.Printf(
			"[BILLING] timezone unavailable: %v",
			err,
		)
		return
	}

	go func() {
		log.Printf(
			"[BILLING] started; timezone=%s",
			location.String(),
		)

		for {
			if ctx.Err() != nil {
				return
			}

			now := time.Now().In(location)
			day := billingDay(now, location)

			if err := chargeDailyBalances(
				ctx,
				day,
			); err != nil {
				if ctx.Err() != nil {
					return
				}

				log.Printf(
					"[BILLING] charge date=%s failed: %v",
					day.Format("2006-01-02"),
					err,
				)

				if !billingSleep(ctx, time.Minute) {
					return
				}

				continue
			}

			// Следующее пробуждение в полночь
			// по часовому поясу Europe/Minsk.
			next := day.AddDate(0, 0, 1)

			if !billingSleep(
				ctx,
				time.Until(next),
			) {
				return
			}
		}
	}()
}

// billingSleep ожидает заданный интервал
// либо завершение контекста.
func billingSleep(
	ctx context.Context,
	duration time.Duration,
) bool {
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

// chargeDailyBalances выполняет ежедневное
// списание для абонентов:
//
//   - статус от 1 до 7;
//   - положительный баланс;
//   - регистрация раньше начала расчётного дня.
//
// Абоненты, зарегистрированные сегодня,
// начинают тарифицироваться со следующего дня.
func chargeDailyBalances(
	ctx context.Context,
	day time.Time,
) error {
	discount, err := billingDiscount()
	if err != nil {
		return err
	}

	var ids []uint

	err = db.WithContext(ctx).
		Model(&models.User{}).
		Where(
			"status > ? AND status < ? "+
				"AND balance > ? AND created_at < ?",
			0,
			8,
			0,
			day,
		).
		Pluck("id", &ids).Error

	if err != nil {
		return fmt.Errorf(
			"load eligible users: %w",
			err,
		)
	}

	processed := 0

	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return err
		}

		charged, err := chargeOneUser(
			ctx,
			id,
			day,
			discount,
		)

		if err != nil {
			// Ошибку фиксируем в журнале.
			// Worker повторит обработку через минуту.
			log.Printf(
				"[BILLING] user_id=%d: %v",
				id,
				err,
			)

			return err
		}

		if charged {
			processed++
		}
	}

	log.Printf(
		"[BILLING] date=%s users_charged=%d",
		day.Format("2006-01-02"),
		processed,
	)

	return nil
}

// chargeOneUser выполняет одно ежедневное
// списание с абонента.
//
// В одной транзакции:
//
// 1. Блокирует абонента.
// 2. Проверяет статус и баланс.
// 3. Рассчитывает ежедневную стоимость.
// 4. Создаёт запись BalanceTransaction.
// 5. Списывает деньги.
// 6. Записывает остаток balance_after.
//
// Любая ошибка приводит к откату транзакции.
func chargeOneUser(
	ctx context.Context,
	userID uint,
	day time.Time,
	discount int,
) (bool, error) {
	charged := false

	err := db.WithContext(ctx).Transaction(
		func(tx *gorm.DB) error {
			var user models.User

			// Блокировка записи пользователя.
			err := tx.Clauses(
				clause.Locking{
					Strength: "UPDATE",
				},
			).
				First(&user, userID).Error

			if err != nil {
				if errors.Is(
					err,
					gorm.ErrRecordNotFound,
				) {
					return nil
				}

				return err
			}

			// Проверяем статус и дату регистрации.
			if user.Status == 0 ||
				user.Status >= 8 ||
				!user.CreatedAt.Before(day) {
				return nil
			}

			// Проверяем положительный баланс.
			// Отдельное имя переменной исключает
			// повторное объявление balance.
			var balanceCheck struct {
				Positive int `gorm:"column:positive"`
			}

			err = tx.Raw(
				"SELECT (balance > 0) AS positive "+
					"FROM users WHERE id = ?",
				userID,
			).Scan(&balanceCheck).Error

			if err != nil {
				return err
			}

			if balanceCheck.Positive != 1 {
				return nil
			}

			// Скидка действует только для
			// премиального статуса 2.
			userDiscount := 0

			if user.Status == 2 {
				userDiscount = discount
			}

			// Рассчитываем месячную и дневную
			// стоимость активных пакетов.
			//
			// Используется DECIMAL, а не float64.
			var sums struct {
				MonthlyTotal string `gorm:"column:monthly_total"`
				Amount       string `gorm:"column:amount"`
			}

			days := billingDaysInMonth(day)
			index := day.Day()

			err = tx.Raw(`
SELECT
    CAST(
        discounted_total AS CHAR
    ) AS monthly_total,

    CAST(
        CAST(
            ROUND(discounted_total * ? / ?, 2) -
            ROUND(discounted_total * ? / ?, 2)
            AS DECIMAL(12,2)
        )
        AS CHAR
    ) AS amount

FROM (
    SELECT
        CAST(
            ROUND(
                COALESCE(SUM(p.monthly_price), 0) *
                (100 - ?) / 100,
                2
            )
            AS DECIMAL(12,2)
        ) AS discounted_total

    FROM user_packages up
    JOIN packages p
        ON p.id = up.package_id

    WHERE up.user_id = ?
      AND p.enabled = 1
) AS totals`,
				index,
				days,
				index-1,
				days,
				userDiscount,
				userID,
			).Scan(&sums).Error

			if err != nil {
				return err
			}

			// Проверяем результат расчёта.
			if strings.TrimSpace(sums.Amount) == "" {
				return errors.New(
					"invalid daily charge",
				)
			}

			if strings.TrimSpace(
				sums.MonthlyTotal,
			) == "" {
				return errors.New(
					"invalid monthly total",
				)
			}

			// Проверяем положительность списания.
			var chargeCheck struct {
				Positive int `gorm:"column:positive"`
			}

			err = tx.Raw(
				"SELECT "+
					"(CAST(? AS DECIMAL(12,2)) > 0) "+
					"AS positive",
				sums.Amount,
			).Scan(&chargeCheck).Error

			if err != nil {
				return err
			}

			// Нулевая стоимость пакетов —
			// не создаём финансовую операцию.
			if chargeCheck.Positive != 1 {
				return nil
			}

			// Уникальный ключ ежедневного списания.
			operationKey := fmt.Sprintf(
				"daily:%d:%s",
				userID,
				day.Format("2006-01-02"),
			)

			chargeDate := day
			monthlyTotal := sums.MonthlyTotal

			// Создаём запись в универсальном журнале.
			//
			// Отрицательная сумма означает списание.
			ledger := models.BalanceTransaction{
				UserID:       userID,
				Type:         models.BalanceDailyCharge,
				Amount:       "-" + sums.Amount,
				OperationKey: operationKey,
				ChargeDate:   &chargeDate,
				MonthlyTotal: &monthlyTotal,
			}

			// ON CONFLICT DO NOTHING:
			// для MySQL GORM использует
			// ON DUPLICATE KEY UPDATE.
			//
			// Если операция уже существует,
			// повторно деньги не списываем.
			insert := tx.Clauses(
				clause.OnConflict{
					DoNothing: true,
				},
			).Create(&ledger)

			if insert.Error != nil {
				return insert.Error
			}

			if insert.RowsAffected == 0 {
				return nil
			}

			// Списываем ежедневную стоимость
			// непосредственно средствами MySQL.
			result := tx.Model(&models.User{}).
				Where("id = ?", userID).
				UpdateColumn(
					"balance",
					gorm.Expr(
						"balance - CAST(? AS DECIMAL(12,2))",
						sums.Amount,
					),
				)

			if result.Error != nil {
				return result.Error
			}

			if result.RowsAffected != 1 {
				return fmt.Errorf(
					"daily balance update failed: user_id=%d",
					userID,
				)
			}

			// Читаем фактический остаток после
			// списания внутри той же транзакции.
			var balanceAfter struct {
				Value string `gorm:"column:balance"`
			}

			read := tx.Raw(
				"SELECT CAST(balance AS CHAR) AS balance "+
					"FROM users WHERE id = ?",
				userID,
			).Scan(&balanceAfter)

			if read.Error != nil {
				return read.Error
			}

			if read.RowsAffected != 1 ||
				strings.TrimSpace(
					balanceAfter.Value,
				) == "" {
				return fmt.Errorf(
					"invalid balance after daily charge: user_id=%d",
					userID,
				)
			}

			// Сохраняем остаток после операции
			// в универсальном журнале.
			result = tx.Model(&ledger).
				UpdateColumn(
					"balance_after",
					balanceAfter.Value,
				)

			if result.Error != nil {
				return result.Error
			}

			if result.RowsAffected != 1 {
				return fmt.Errorf(
					"failed to save balance_after: user_id=%d",
					userID,
				)
			}

			charged = true

			return nil
		},
	)

	// Возвращаем true только после
	// успешной фиксации всей транзакции.
	if err != nil {
		return false, err
	}

	return charged, nil
}
