package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"main/models"
	"os"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
	"gorm.io/gorm/schema"
)

const (
	dbName = "tvaplay"
	dbUser = "tvaplay"
	dbPass = "tvaplay"

	// Административное подключение к локальному MySQL.
	mysqlRootDSN = "root@unix(/var/run/mysqld/mysqld.sock)/?timeout=3s"

	PREFIX = ""
)

// generateSettingToken создаёт криптографически случайную
// строку из латинских букв и цифр заданной длины.
//
// Используется для JWT, HLS и других секретных ключей.
func generateSettingToken(length int) (string, error) {
	if length <= 0 {
		return "", fmt.Errorf("invalid token length: %d", length)
	}

	const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

	result := make([]byte, 0, length)
	random := make([]byte, 64)

	for len(result) < length {
		if _, err := rand.Read(random); err != nil {
			return "", fmt.Errorf("generate random token: %w", err)
		}

		for _, b := range random {
			if len(result) == length {
				break
			}

			// Rejection sampling: исключаем смещение
			// распределения при выборе из 62 символов.
			if b >= 248 {
				continue
			}

			result = append(result, alphabet[int(b)%len(alphabet)])
		}
	}

	return string(result), nil
}

func ensureDatabase() error {
	adminDB, err := sql.Open("mysql", mysqlRootDSN)
	if err != nil {
		return fmt.Errorf("MySQL admin open: %w", err)
	}
	defer adminDB.Close()

	if err := adminDB.Ping(); err != nil {
		return fmt.Errorf("MySQL admin connect: %w", err)
	}

	queries := []string{
		fmt.Sprintf(
			"CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
			dbName,
		),
		fmt.Sprintf(
			"CREATE USER IF NOT EXISTS '%s'@'127.0.0.1' IDENTIFIED BY '%s'",
			dbUser, dbPass,
		),
		fmt.Sprintf(
			"GRANT ALL PRIVILEGES ON `%s`.* TO '%s'@'127.0.0.1'",
			dbName, dbUser,
		),
	}

	for _, query := range queries {
		if _, err := adminDB.Exec(query); err != nil {
			return fmt.Errorf("MySQL initialization: %w", err)
		}
	}

	log.Println("MySQL database and user verified")
	return nil
}

func initDatabase() {
	dsn := fmt.Sprintf(
		"%s:%s@tcp(127.0.0.1:3306)/%s?charset=utf8mb4&parseTime=True&loc=Local&timeout=3s&readTimeout=5s&writeTimeout=5s",
		dbUser,
		dbPass,
		dbName,
	)

	// Первичная проверка и создание БД/пользователя.
	if err := ensureDatabase(); err != nil {
		log.Fatal("DB initialization error: ", err)
	}

	gormLogger := logger.New(
		log.New(os.Stdout, "\r\n", log.LstdFlags),
		logger.Config{
			SlowThreshold:             200 * time.Millisecond,
			IgnoreRecordNotFoundError: true,
			ParameterizedQueries:      true,
			Colorful:                  false,
			LogLevel: func() logger.LogLevel {
				if debug {
					return logger.Warn
				}
				return logger.Error
			}(),
		},
	)

	var err error

	db, err = gorm.Open(
		mysql.Open(dsn),
		&gorm.Config{
			Logger: gormLogger,
			NamingStrategy: schema.NamingStrategy{
				TablePrefix:   PREFIX,
				SingularTable: false,
			},
		},
	)
	if err != nil {
		log.Fatal("DB open error: ", err)
	}

	// Register custom many-to-many join tables.

	if err := db.SetupJoinTable(
		&models.Channel{},
		"Packages",
		&models.ChannelPackage{},
	); err != nil {
		log.Fatal("DB setup Channel.Packages: ", err)
	}

	if err := db.SetupJoinTable(
		&models.Package{},
		"Channels",
		&models.ChannelPackage{},
	); err != nil {
		log.Fatal("DB setup Package.Channels: ", err)
	}

	if err := db.SetupJoinTable(
		&models.User{},
		"Packages",
		&models.UserPackage{},
	); err != nil {
		log.Fatal("DB setup User.Packages: ", err)
	}

	// Create and migrate database tables.

	if err = db.AutoMigrate(models.AllModels...); err != nil {
		slog("DB migrate error: "+err.Error(), "error")
		log.Fatal(err)
	}

	if err := ensureBillingIDIndex(db); err != nil {
		log.Fatal(err)
	}

	log.Println("MySQL AutoMigrate completed")

	// Добавляем только отсутствующие системные настройки.
	if err = initDefaultSettings(); err != nil {
		log.Fatal("DB default settings error: ", err)
	}

	log.Println("MySQL initialization completed")
}

func ensureBillingIDIndex(db *gorm.DB) error {
	if !db.Migrator().HasColumn(&models.User{}, "billing_id_unique") {
		if err := db.Exec(`
            ALTER TABLE users
            ADD COLUMN billing_id_unique BIGINT UNSIGNED
            GENERATED ALWAYS AS (NULLIF(billing_id, 0)) STORED
        `).Error; err != nil {
			return fmt.Errorf("create billing_id_unique: %w", err)
		}
	}

	if !db.Migrator().HasIndex(&models.User{}, "ux_users_billing_id_positive") {
		if err := db.Exec(`
            CREATE UNIQUE INDEX ux_users_billing_id_positive
            ON users (billing_id_unique)
        `).Error; err != nil {
			return fmt.Errorf("create unique billing_id index: %w", err)
		}
	}

	return nil
}

// ██████╗ ███████╗███████╗ █████╗ ██╗   ██╗██╗
// ██╔══██╗██╔════╝██╔════╝██╔══██╗██║   ██║██║
// ██║  ██║█████╗  █████╗  ███████║██║   ██║██║
// ██║  ██║██╔══╝  ██╔══╝  ██╔══██║██║   ██║██║
// ██████╔╝███████╗██║     ██║  ██║╚██████╔╝███████╗
// ╚═════╝ ╚══════╝╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝

// initDefaultSettings добавляет отсутствующие настройки.
//
// ВАЖНО:
// - существующие значения не изменяются;
// - секреты генерируются криптографически безопасно;
// - installation_id сохраняется между перезапусками;
// - новая установка получает все необходимые ключи.
func initDefaultSettings() error {

	// API key: 32 случайных байта в HEX (64 символа).
	apiKeyBytes := make([]byte, 32)
	if _, err := rand.Read(apiKeyBytes); err != nil {
		return fmt.Errorf("generate API key: %w", err)
	}

	apiKey := hex.EncodeToString(apiKeyBytes)

	// JWT secret: ровно 32 ASCII-символа.
	jwtToken, err := generateSettingToken(32)
	if err != nil {
		return fmt.Errorf("generate JWT secret: %w", err)
	}

	// HLS/archive token: ровно 32 ASCII-символа.
	hlsToken, err := generateSettingToken(32)
	if err != nil {
		return fmt.Errorf("generate HLS token: %w", err)
	}

	type defaultSetting struct {
		Key         string `gorm:"column:key"`
		Value       string `gorm:"column:value"`
		LastValue   string `gorm:"column:last_value"`
		Description string `gorm:"column:description"`
		Position    uint64 `gorm:"column:position"`
	}

	defaults := []defaultSetting{
		{
			Key:         "epglink",
			Value:       "https://example.com/xmltv.xml",
			Description: "Link or path for XMLTV EPG (.xml or .gz)",
			Position:    1,
		},
		{
			Key:         "smsgate",
			Value:       "./smsgate.sh",
			Description: "SMS Gateway script",
			Position:    2,
		},
		{
			Key:         "archive_trusted_proxy_ip",
			Value:       "",
			Description: "Trusted proxy IP for archive playback",
			Position:    3,
		},
		{
			Key:         "phone_regex",
			Value:       `^\+[1-9][0-9]{7,14}$`,
			Description: "International phone number validation (E.164), ex: ^\\+[1-9][0-9]{7,14}$",
			Position:    4,
		},
		{
			Key:         "max_dev_for_new",
			Value:       "1",
			Description: "Maximum number of devices (w/o license only 1)",
			Position:    5,
		},
		{
			Key:         "balance_for_new",
			Value:       "0.10",
			Description: "Init balance",
			Position:    6,
		},
		{
			Key:         "promo_chid",
			Value:       "0",
			Description: "Advert channel ID",
			Position:    7,
		},
		{
			Key:         "up_balance_url",
			Value:       "https://tvaplay.com/payment",
			Description: "QR code for replenishing balance",
			Position:    8,
		},
		{
			Key:         "currency",
			Value:       "USD",
			Description: "Currency",
			Position:    9,
		},
		{
			Key:         "discount",
			Value:       "100",
			Description: "Discount percent for premium subscribers",
			Position:    10,
		},
		{
			Key:         "api_key",
			Value:       apiKey,
			Description: "API key",
			Position:    11,
		},
		{
			Key:         "pause_tax",
			Value:       "2.00",
			Description: "Amount for pausing",
			Position:    13,
		},
		{
			Key:         "resume_tax",
			Value:       "0.00",
			Description: "Amount for unpausing",
			Position:    14,
		},
		{
			Key:         "brandname",
			Value:       "TVAPLAY",
			Description: "Name of brand",
			Position:    15,
		},
		{
			Key:         "copyright",
			Value:       "Copyright by TVAPLAY.COM",
			Description: "Half signature of copyright (may HTML)",
			Position:    16,
		},
		{
			Key:         "start_hls_port",
			Value:       "15000",
			Description: "Start HLS port [127.0.0.1:<PORT>+<CHID>]",
			Position:    17,
		},
		{
			Key:         "logo_path",
			Value:       "",
			Description: "Logo.png path on the server (recommended 250x250px)",
			Position:    18,
		},
		{
			Key:         "license",
			Value:       "",
			Description: "License key",
			Position:    19,
		},
		{
			Key:         "jwt_token",
			Value:       jwtToken,
			Description: "User authorization & HLS-live token",
			Position:    20,
		},
		{
			Key:         "hls_token",
			Value:       hlsToken,
			Description: "HLS-archive token",
			Position:    21,
		},
	}

	// Вставляем только отсутствующие строки.
	// Существующие value, last_value, description,
	// position и updated_at не изменяются.
	result := db.Table("settings").
		Clauses(clause.OnConflict{DoNothing: true}).
		Create(&defaults)

	if result.Error != nil {
		return fmt.Errorf(
			"initialize default settings: %w",
			result.Error,
		)
	}

	log.Printf(
		"MySQL default settings verified: %d total, %d inserted",
		len(defaults),
		result.RowsAffected,
	)

	return nil
}
