package main

import (
	"errors"
	"fmt"
	"main/models"
	"regexp"
	"strings"

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

// getSetting возвращает значение из БД.
// Отсутствующая настройка возвращает "".
func getSetting(key string) string {
	var setting models.Setting

	err := db.Select("value").
		Where("`key` = ?", key).
		First(&setting).Error

	if err != nil {
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			slog("getSetting "+key+": "+err.Error(), "error")
		}
		return ""
	}

	return setting.Value
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

	return db.Transaction(func(tx *gorm.DB) error {
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

			return tx.Create(&models.Setting{
				Key:         key,
				Value:       value,
				Description: description[0],
				Position:    maxPosition + 1,
			}).Error
		}
		if err != nil {
			return err
		}

		updates := map[string]any{}

		if setting.Value != value {
			updates["last_value"] = setting.Value
			updates["value"] = value
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
}
