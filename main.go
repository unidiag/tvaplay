package main

import (
	"context"
	"log"
	"log/syslog"
	"os"
	"time"

	"github.com/oschwald/geoip2-golang"
	"gorm.io/gorm"
)

const APPNAME = "tvaplay"
const APPLINK = "http://github.com/unidiag/tvaplay"
const VERSION = "26.44"
const BUILD_DATE = "2026-11-07"
const BUILD_TIME = "14:47:45"

var (
	debug     = false
	err       error
	db        *gorm.DB
	sysLogger *syslog.Writer // для slog(..)
	dbip      *geoip2.Reader

	accessTTL  = 10 * time.Minute
	refreshTTL = 30 * 24 * time.Hour
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

	initGeoIP() // использовать базу данных IP. можно закомментировать, тогда не используется ./geoip.mmdb

	go epgWorker()
	go archiveWorker() // пишем каналы и стираем старые записи
	go hlsManager(context.Background())
	go webserver()
	startBillingWorker(context.Background())

	for {
		delay(1000)
	}

}
