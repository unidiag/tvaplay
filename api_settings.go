package main

import (
	"errors"
	"main/models"
	"strings"

	"gorm.io/gorm"
)

func settingAPIError(ctx *ApiCtx, message string) map[string]any {
	ctx.Out["status"] = "NOK"
	ctx.Out["message"] = message
	return ctx.Out
}

// POST {"op":"adminSettings"}
func apiAdminSettings(ctx *ApiCtx) map[string]any {
	var items []models.Setting

	err := db.Order("position ASC, `key` ASC").
		Find(&items).Error
	if err != nil {
		return settingAPIError(ctx, "Cannot load settings")
	}

	ctx.Out["settings"] = items
	return ctx.Out
}

//	POST {
//	  "op":"adminSettingSave",
//	  "key":"epglink",
//	  "value":"https://example.com/xmltv.xml",
//	  "description":"Link for EPG",
//	  "create":true
//	}
func apiAdminSettingSave(ctx *ApiCtx) map[string]any {
	key := strings.TrimSpace(ctx.D["key"])
	value := ctx.D["value"]

	if err := validateSettingKey(key); err != nil {
		return settingAPIError(ctx, err.Error())
	}

	_, hasValue := ctx.Data["value"]
	if !hasValue {
		return settingAPIError(ctx, "Value is required")
	}

	create := ctx.D["create"] == "1"

	if key == "phone_regex" {
		if err := validatePhoneRegex(value); err != nil {
			return settingAPIError(ctx, err.Error())
		}
	}

	var err error
	if create {
		description := ctx.D["description"]
		if len(description) > 65535 {
			return settingAPIError(ctx, "Description is too long")
		}

		var count int64
		if err = db.Model(&models.Setting{}).
			Where("`key` = ?", key).
			Count(&count).Error; err != nil {
			return settingAPIError(ctx, "Cannot check setting")
		}
		if count != 0 {
			return settingAPIError(ctx, "Setting already exists")
		}

		err = setSetting(key, value, description)
	} else {
		if _, hasDescription := ctx.Data["description"]; hasDescription {
			err = setSetting(key, value, ctx.D["description"])
		} else {
			err = setSetting(key, value)
		}
	}

	if err != nil {
		return settingAPIError(ctx, err.Error())
	}

	var saved models.Setting
	if err := db.First(&saved, "`key` = ?", key).Error; err != nil {
		return settingAPIError(ctx, "Cannot reload setting")
	}

	ctx.Out["setting"] = saved
	return ctx.Out
}

// POST {"op":"adminSettingDelete","key":"example"}
func apiAdminSettingDelete(ctx *ApiCtx) map[string]any {
	key := strings.TrimSpace(ctx.D["key"])

	if err := validateSettingKey(key); err != nil {
		return settingAPIError(ctx, err.Error())
	}

	result := db.Delete(&models.Setting{}, "`key` = ?", key)
	if result.Error != nil {
		return settingAPIError(ctx, "Cannot delete setting")
	}
	if result.RowsAffected == 0 {
		return settingAPIError(ctx, "Setting not found")
	}

	ctx.Out["key"] = key
	return ctx.Out
}

// При необходимости использовать в других обработчиках,
// где требуется различать пустое значение и ошибку БД.
func getSettingStrict(key string) (string, error) {
	var item models.Setting

	err := db.First(&item, "`key` = ?", key).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", errors.New("setting not found: " + key)
	}
	if err != nil {
		return "", err
	}

	return item.Value, nil
}
