package main

import (
	"context"
	"log"
	"log/syslog"
	"os"
	"sync/atomic"
	"time"

	"github.com/oschwald/geoip2-golang"
	"gorm.io/gorm"
)

const APPNAME = "tvaplay"
const APPLINK = "http://github.com/unidiag/tvaplay"
const VERSION = "26.09"
const BUILD_DATE = "2026-11-21"
const BUILD_TIME = "13:49:25"

var (
	debug     = false
	err       error
	db        *gorm.DB
	sysLogger *syslog.Writer // для slog(..)
	dbip      *geoip2.Reader

	accessTTL  = 10 * time.Minute
	refreshTTL = 45 * 24 * time.Hour

	ARCHIVE_SECRET atomic.Value // Хранит string
)

// ███╗   ███╗ █████╗ ██╗███╗   ██╗
// ████╗ ████║██╔══██╗██║████╗  ██║
// ██╔████╔██║███████║██║██╔██╗ ██║
// ██║╚██╔╝██║██╔══██║██║██║╚██╗██║
// ██║ ╚═╝ ██║██║  ██║██║██║ ╚████║
// ╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝

func main() {

	if os.Geteuid() != 0 {
		log.Fatal("ERROR: program run is not root")
	}

	runtime := time.Now()
	_ = runtime

	sysLogger, err = syslog.New(syslog.LOG_INFO|syslog.LOG_DAEMON, APPNAME)
	if err != nil {
		log.Println("syslog init error:", err)
	}

	debug = isRunThroughGoRun()
	slog("Server run in DEBUG-mode", "debug")

	initDatabase()

	secret := generateArchiveSecret()
	if len(secret) != 64 {
		log.Fatal("ARCHIVE_SECRET initialization failed")
	}

	ARCHIVE_SECRET.Store(secret)

	startViewStatsWorker()

	initGeoIP() // использовать базу данных IP. можно закомментировать, тогда не используется ./geoip.mmdb

	// smsgate.sh
	if !fileExists(getSetting("smsgate")) {
		file, err := staticFiles.ReadFile("build/smsgate.sh")
		if err != nil {
			log.Printf("Failed to read smsgate.sh: %v", err)
		} else if err := os.WriteFile(getSetting("smsgate"), file, 0755); err != nil {
			log.Printf("Failed to write smsgate.sh: %v", err)
		}
	}

	go epgWorker()
	go archiveWorker() // пишем каналы и стираем старые записи
	go hlsManager(context.Background())
	go webserver()
	startBillingWorker(context.Background())
	startStorageIOWorker()
	go refreshTokensCleanup(context.Background()) // раз в час чистка истекших токенов

	for {
		delay(1000)
	}

}
