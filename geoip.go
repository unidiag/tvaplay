package main

import (
	"log"
	"net"
	"os"
	"strings"

	"github.com/oschwald/geoip2-golang"
)

func initGeoIP() {
	// geoip database
	if !fileExists("./geoip.mmdb") {
		file, _ := staticFiles.ReadFile("build/geo.ip")
		os.WriteFile("./geoip.mmdb", file, 0644)
	}
	// читаем базу данных ip чтобы лежала всегда в озу
	dbip, err = geoip2.Open("./geoip.mmdb")
	if err != nil {
		log.Fatal("GeoIP open error: " + err.Error())
	}
	// defer dbip.Close()
}

// возвращает код страны по IP v4
func geoIP(ip string) string {
	ipAddr := net.ParseIP(ip)
	record, err := dbip.Country(ipAddr)
	if err != nil {
		return "?"
	}
	return record.Country.IsoCode
}

func parseList(s string) []string {
	s = strings.ReplaceAll(s, " ", "")
	if s == "" {
		return nil
	}
	arr := strings.Split(s, ",")
	for i := range arr {
		arr[i] = strings.ToUpper(arr[i])
	}
	return arr
}

func containsList(arr []string, val string) bool {
	val = strings.ToUpper(val)
	for _, v := range arr {
		if v == val {
			return true
		}
	}
	return false
}
