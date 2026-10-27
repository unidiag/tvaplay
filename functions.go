package main

import (
	"crypto/md5"
	"embed"
	"encoding/hex"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/fatih/color"
)

//go:embed build/*
var staticFiles embed.FS

type FileInfo struct {
	Path  string
	IsDir bool
}

// это для файлов ./build вебсервера
func readDirRecursively(dirPath string) ([]FileInfo, error) {
	var result []FileInfo
	files, err := staticFiles.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}
	for _, file := range files {
		fullPath := dirPath + "/" + file.Name()

		info := FileInfo{
			Path:  fullPath,
			IsDir: file.IsDir(),
		}
		result = append(result, info)
		if file.IsDir() {
			subdirContents, err := readDirRecursively(fullPath)
			if err != nil {
				return nil, err
			}
			result = append(result, subdirContents...)
		}
	}
	return result, nil
}

func md5hash(s string) string {
	h := md5.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

func translit(text string) string {
	var translitMap = map[rune]string{
		'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d",
		'е': "e", 'ё': "yo", 'ж': "zh", 'з': "z", 'и': "i",
		'й': "y", 'к': "k", 'л': "l", 'м': "m", 'н': "n",
		'о': "o", 'п': "p", 'р': "r", 'с': "s", 'т': "t",
		'у': "u", 'ф': "f", 'х': "h", 'ц': "ts", 'ч': "ch",
		'ш': "sh", 'щ': "sch", 'ъ': "", 'ы': "y", 'ь': "",
		'э': "e", 'ю': "yu", 'я': "ya",

		'А': "A", 'Б': "B", 'В': "V", 'Г': "G", 'Д': "D",
		'Е': "E", 'Ё': "Yo", 'Ж': "Zh", 'З': "Z", 'И': "I",
		'Й': "Y", 'К': "K", 'Л': "L", 'М': "M", 'Н': "N",
		'О': "O", 'П': "P", 'Р': "R", 'С': "S", 'Т': "T",
		'У': "U", 'Ф': "F", 'Х': "H", 'Ц': "Ts", 'Ч': "Ch",
		'Ш': "Sh", 'Щ': "Sch", 'Ъ': "", 'Ы': "Y", 'Ь': "",
		'Э': "E", 'Ю': "Yu", 'Я': "Ya",
	}
	var b strings.Builder
	for _, r := range text {
		if v, ok := translitMap[r]; ok {
			b.WriteString(v)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func getFileExtension(filePath string) string {
	parts := strings.Split(filePath, "/")
	fileName := parts[len(parts)-1]
	fileParts := strings.Split(fileName, ".")
	if len(fileParts) > 1 {
		extension := fileParts[len(fileParts)-1]
		return extension
	}
	return ""
}

func getLocalIP() string {
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {

			ipnet, ok := addr.(*net.IPNet)
			if !ok || ipnet.IP.IsLoopback() {
				continue
			}

			if ipnet.IP.To4() != nil {
				return ipnet.IP.String()
			}
		}
	}
	return "127.0.0.1"
}

func slog(s ...string) {
	msg := ""
	level := "INFO"
	ts := formatDate(time.Now())
	if len(s) == 2 {
		level = strings.ToUpper(s[1])
		msg = s[0]
	} else if len(s) == 1 {
		msg = s[0]
	}
	if !debug && level == "DEBUG" {
		return
	}
	line := fmt.Sprintf("%s [%s] %s", ts, level, msg)
	// ---- console color
	switch strings.ToLower(level) {
	case "err", "error":
		color.Red(line)
	case "warn":
		color.Yellow(line)
	case "debug":
		color.Cyan(line)
	default:
		fmt.Println(line)
	}
	// ---- system log
	if sysLogger != nil {
		switch strings.ToLower(level) {
		case "err", "error":
			sysLogger.Err(msg)
		case "warn":
			sysLogger.Warning(msg)
		case "debug":
			sysLogger.Debug(msg)
		default:
			sysLogger.Info(msg)
		}
	}
}

func echo(s any) {
	tt := time.Now().Format("2006/01/02 15:04:05.000")
	switch reflect.TypeOf(s).String() {
	case "string":
		color.Blue("%s %s\n", tt, s)
	case "int", "uint", "uint32", "int32", "uint64", "int64":
		color.Green("%s %d\n", tt, s)
	case "[]uint8":
		color.Yellow("%s %02X\n", tt, s)
	}
}

func unixtime() int {
	return int(time.Now().Unix())
}

func getClientAgent(r *http.Request) string {
	return r.Header.Get("User-Agent")
}

// getClientIP извлекает IPv4-адрес из заголовков X-Forwarded-For, X-Real-IP или r.RemoteAddr
func getClientIP(r *http.Request) string {
	// Проверяем X-Forwarded-For (может содержать несколько IP через запятую)
	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		ips := strings.Split(xff, ",")
		for _, ip := range ips {
			cleanIP := strings.TrimSpace(ip)
			if isIPv4(cleanIP) {
				return cleanIP
			}
		}
	}
	xri := r.Header.Get("X-Real-IP")
	if xri != "" && isIPv4(xri) {
		return xri
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return ip
	}
	if isIPv4(parsedIP.String()) {
		return parsedIP.String()
	}
	if parsedIP.IsLoopback() {
		return "127.0.0.1"
	}

	return ip
}

// isIPv4 проверяет, является ли строка IPv4-адресом
func isIPv4(ip string) bool {
	parsedIP := net.ParseIP(ip)
	return parsedIP != nil && parsedIP.To4() != nil
}

// возвращаем по unixtime форматированное время
func formatDate(t time.Time) string {
	return t.Format("2006-01-02 15:04:05.999")
}

// установка cookie
func setCookie(name, value string, days int, w http.ResponseWriter) {
	cookie := &http.Cookie{
		Name:  name,
		Value: value,
		Path:  "/", // Доступна на всем сайте
		//HttpOnly: true, // Защита от XSS (не доступна JavaScript)
		//Secure: true, // Будет отправляться только через HTTPS
		//SameSite: http.SameSiteStrictMode,
		MaxAge: days * 86400,
	}
	http.SetCookie(w, cookie)
}

// определяет что запущено в дебаг-режиме
func isRunThroughGoRun() bool {
	exePath, err := os.Executable()
	if err != nil {
		panic(err)
	}
	exeDir := filepath.Dir(exePath)
	mainGoPath := filepath.Join(exeDir, "main")
	if _, err := os.Stat(mainGoPath); err == nil {
		return true
	}
	return false
}

func delay(milliseconds int) {
	time.Sleep(time.Duration(milliseconds) * time.Millisecond)
}

func fileExists(filename string) bool {
	_, err := os.Stat(filename)
	return !os.IsNotExist(err)
}

func checkInArray(a []string, b string) bool {
	for i := 0; i < len(a); i++ {
		if a[i] == b {
			return true
		}
	}
	return false
}

func randomString(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyz" +
		"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	seededRand := rand.New(rand.NewSource(time.Now().UnixNano()))
	b := make([]byte, length)
	for i := range b {
		b[i] = charset[seededRand.Intn(len(charset))]
	}
	return string(b)
}

func getRandomNumber(p int) int {
	rand.Seed(time.Now().UnixNano()) // Инициализация генератора случайных чисел текущим временем
	return rand.Intn(p + 1)          // Генерация случайного числа от 0 до 10 (включительно)
}

// Преобразует список IP/CIDR в netip.Prefix.
func parseIPNetworks(items []string) []netip.Prefix {
	result := make([]netip.Prefix, 0, len(items))

	for _, item := range items {
		if prefix, err := netip.ParsePrefix(item); err == nil {
			result = append(result, prefix.Masked())
			continue
		}

		if ip, err := netip.ParseAddr(item); err == nil {
			result = append(result,
				netip.PrefixFrom(ip, ip.BitLen()))
		}
	}

	return result
}

// isAllowedIP возвращает true, если IP
// относится к bogon-сетям или whitelist.
func isAllowedIP(ip string) bool {

	// Bogon и специальные диапазоны IPv4/IPv6.
	// Список статический: не включает динамически
	// обновляемые списки ещё не выделенных адресов.
	var bogonNetworks = []string{
		// IPv4
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"192.168.0.0/16",
		"198.18.0.0/15",
		"198.51.100.0/24",
		"203.0.113.0/24",
		"224.0.0.0/4",
		"240.0.0.0/4",

		// IPv6
		"::/128",
		"::1/128",
		"::ffff:0:0/96",
		"64:ff9b:1::/48",
		"100::/64",
		"2001:db8::/32",
		"fc00::/7",
		"fe80::/10",
		"ff00::/8",
	}

	var allowedPrefixes = parseIPNetworks(whitelist)
	var bogonPrefixes = parseIPNetworks(bogonNetworks)

	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}

	// Поддержка IPv4-mapped IPv6.
	addr = addr.Unmap()

	for _, prefix := range allowedPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}

	for _, prefix := range bogonPrefixes {
		if prefix.Contains(addr) {
			return true
		}
	}

	return false
}
