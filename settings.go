package main

import (
	"errors"
	"fmt"
	"main/models"
	"regexp"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var settingKeyRE = regexp.MustCompile(
	`^[a-z][a-z0-9_.-]{0,127}$`,
)

func validateSettingKey(key string) error {
	if !settingKeyRE.MatchString(key) {
		return errors.New("invalid setting key")
	}
	return nil
}

const settingCacheTTL = 10 * time.Second

type settingCacheEntry struct {
	value     string
	expiresAt time.Time
}

var settingCache = struct {
	sync.Mutex
	items map[string]settingCacheEntry
}{
	items: make(map[string]settingCacheEntry),
}

// getSetting возвращает значение настройки.
// Повторные обращения используют кеш в памяти.
func getSetting(key string) string {
	now := time.Now()

	settingCache.Lock()
	defer settingCache.Unlock()

	// 1. Проверяем кеш.
	if entry, ok := settingCache.items[key]; ok {
		if now.Before(entry.expiresAt) {
			return entry.value
		}
	}

	// 2. Кеш отсутствует или устарел.
	var setting models.Setting

	err := db.Select("value").
		Where("`key` = ?", key).
		First(&setting).Error

	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			slog(
				"getSetting "+key+": "+err.Error(),
				"error",
			)

			// Ошибки БД не кешируем.
			delete(settingCache.items, key)
			return ""
		}

		// Настройка не найдена.
		// Кешируем отсутствие настройки,
		// чтобы не выполнять повторные SELECT.
		settingCache.items[key] = settingCacheEntry{
			value:     "",
			expiresAt: time.Now().Add(settingCacheTTL),
		}

		return ""
	}

	// 3. Сохраняем результат в кеше.
	settingCache.items[key] = settingCacheEntry{
		value:     setting.Value,
		expiresAt: time.Now().Add(settingCacheTTL),
	}

	return setting.Value
}

// invalidateSetting удаляет настройку из кеша.
// Следующий getSetting() загрузит её из MySQL.
func invalidateSetting(key string) {
	settingCache.Lock()
	delete(settingCache.items, key)
	settingCache.Unlock()
}

// invalidateAllSettings очищает весь кеш.
func invalidateAllSettings() {
	settingCache.Lock()
	settingCache.items = make(map[string]settingCacheEntry)
	settingCache.Unlock()
}

// setSetting:
//
// 2 аргумента: изменение существующей настройки.
// 3 аргумента: создание или изменение с описанием.

func setSetting(key, value string, description ...string) error {
	key = strings.TrimSpace(key)

	if err := validateSettingKey(key); err != nil {
		return err
	}
	if len(description) > 1 {
		return errors.New("too many description arguments")
	}
	if len(value) > 65535 {
		return errors.New("setting value is too long")
	}
	if len(description) == 1 && len(description[0]) > 65535 {
		return errors.New("description is too long")
	}

	valueChanged := false

	err := db.Transaction(func(tx *gorm.DB) error {
		var setting models.Setting

		err := tx.Clauses(clause.Locking{
			Strength: "UPDATE",
		}).Where("`key` = ?", key).
			First(&setting).Error

		if errors.Is(err, gorm.ErrRecordNotFound) {
			if len(description) == 0 {
				return fmt.Errorf("setting %q not found", key)
			}

			var maxPosition uint
			if err := tx.Model(&models.Setting{}).
				Select("COALESCE(MAX(position), 0)").
				Scan(&maxPosition).Error; err != nil {
				return err
			}

			if err := tx.Create(&models.Setting{
				Key:         key,
				Value:       value,
				Description: description[0],
				Position:    maxPosition + 1,
			}).Error; err != nil {
				return err
			}

			valueChanged = true
			return nil
		}

		if err != nil {
			return err
		}

		updates := map[string]any{}

		if setting.Value != value {
			updates["last_value"] = setting.Value
			updates["value"] = value
			valueChanged = true
		}

		if len(description) == 1 &&
			setting.Description != description[0] {
			updates["description"] = description[0]
		}

		if len(updates) == 0 {
			return nil
		}

		return tx.Model(&setting).Updates(updates).Error
	})

	// Транзакция завершилась ошибкой.
	// Кеш не трогаем.
	if err != nil {
		return err
	}

	// Новое значение уже зафиксировано в MySQL.
	// Следующий getSetting() загрузит актуальную настройку.
	if valueChanged {
		invalidateSetting(key)
	}

	return nil
}
