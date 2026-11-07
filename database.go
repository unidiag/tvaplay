package main

import (
	"database/sql"
	"fmt"
	"log"
	"main/models"
	"os"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
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
			"CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci",
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

	if err = db.AutoMigrate(models.AllModels...); err != nil {
		slog("DB migrate error: "+err.Error(), "error")
		log.Fatal(err)
	}

	log.Println("MySQL AutoMigrate completed")
}
