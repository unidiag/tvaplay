package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"main/models"

	"golang.org/x/text/encoding/charmap"
	"gorm.io/gorm"
)

// This scanner follows chandetector's approach: discover multicast UDP
// endpoints visible in the OS socket table, then inspect DVB SDT (PID 0x11).
// It does NOT brute-force the entire multicast address space.
const (
	udpSearchTimeout       = 200 * time.Millisecond
	udpSearchMaxCandidates = 512
	udpSearchWorkers       = 2
)

type udpSearchCandidate struct {
	IP   string
	Port int
}
type udpSearchFound struct {
	UDP       string `json:"udp"`
	Name      string `json:"name"`
	Provider  string `json:"provider,omitempty"`
	ServiceID uint16 `json:"service_id,omitempty"`
}
type udpSearchState struct {
	State      string           `json:"state"`
	Total      int              `json:"total"`
	Scanned    int              `json:"scanned"`
	Found      int              `json:"found"`
	Added      int              `json:"added"`
	Skipped    int              `json:"skipped"`
	Error      string           `json:"error,omitempty"`
	StartedAt  time.Time        `json:"started_at,omitempty"`
	FinishedAt time.Time        `json:"finished_at,omitempty"`
	Channels   []udpSearchFound `json:"channels"`
}

var udpSearchJob = struct {
	sync.Mutex
	Value udpSearchState
}{Value: udpSearchState{State: "idle", Channels: []udpSearchFound{}}}

// POST {"op":"adminUDPSearchStart"}
func apiAdminUDPSearchStart(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	udpSearchJob.Lock()
	if udpSearchJob.Value.State == "running" {
		udpSearchJob.Unlock()
		return channelError(ctx, "UDP search is already running")
	}
	udpSearchJob.Value = udpSearchState{State: "running", StartedAt: time.Now(), Channels: []udpSearchFound{}}
	udpSearchJob.Unlock()
	go runAdminUDPSearch()
	ctx.Out["job"] = getUDPSearchState()
	return ctx.Out
}

// POST {"op":"adminUDPSearchStatus"}
func apiAdminUDPSearchStatus(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	ctx.Out["job"] = getUDPSearchState()
	return ctx.Out
}

func getUDPSearchState() udpSearchState {
	udpSearchJob.Lock()
	defer udpSearchJob.Unlock()
	result := udpSearchJob.Value
	result.Channels = append([]udpSearchFound(nil), result.Channels...)
	if result.Channels == nil {
		result.Channels = []udpSearchFound{}
	}
	return result
}
func updateUDPSearch(fn func(*udpSearchState)) {
	udpSearchJob.Lock()
	defer udpSearchJob.Unlock()
	fn(&udpSearchJob.Value)
}
func finishUDPSearch(err error) {
	updateUDPSearch(func(s *udpSearchState) {
		s.FinishedAt = time.Now()
		if err != nil {
			s.State = "error"
			s.Error = err.Error()
		} else {
			s.State = "done"
		}
	})
}

func runAdminUDPSearch() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[UDP SEARCH] panic: %v", r)
			finishUDPSearch(fmt.Errorf("scanner panic: %v", r))
		}
	}()
	candidates, err := detectMulticastUDPEndpoints()
	if err != nil {
		finishUDPSearch(err)
		return
	}
	updateUDPSearch(func(s *udpSearchState) { s.Total = len(candidates) })
	if len(candidates) == 0 {
		finishUDPSearch(nil)
		return
	}

	jobs := make(chan udpSearchCandidate)
	found := make(chan udpSearchFound, len(candidates))
	var wg sync.WaitGroup
	for i := 0; i < udpSearchWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for candidate := range jobs {
				result, err := probeDVBService(candidate)

				updateUDPSearch(func(s *udpSearchState) {
					s.Scanned++
				})

				if err != nil {
					log.Printf(
						"[UDP SEARCH] %s:%d: %v",
						candidate.IP,
						candidate.Port,
						err,
					)
					continue
				}

				log.Printf(
					"[UDP SEARCH] found %s:%d -> %s",
					candidate.IP,
					candidate.Port,
					result.Name,
				)

				found <- result
			}
		}()
	}
	go func() {
		for _, candidate := range candidates {
			jobs <- candidate
		}
		close(jobs)
		wg.Wait()
		close(found)
	}()
	var detected []udpSearchFound
	for result := range found {
		detected = append(detected, result)
		updateUDPSearch(func(s *udpSearchState) { s.Found++ })
	}
	sort.Slice(detected, func(i, j int) bool { return detected[i].UDP < detected[j].UDP })
	if err := insertDetectedChannels(detected); err != nil {
		finishUDPSearch(err)
		return
	}
	finishUDPSearch(nil)
}

// Detect addresses from the socket table, exactly the discovery model of
// chandetector. netstat is preferred; ss is a fallback on modern Linux.
var multicastEndpointRE = regexp.MustCompile(`(?i)(2(?:2[4-9]|3\d)\.(?:\d{1,3}\.){2}\d{1,3}):(\d{1,5})`)

func detectMulticastUDPEndpoints() ([]udpSearchCandidate, error) {
	var output []byte
	var err error
	for _, cmd := range [][]string{{"netstat", "-u", "-n", "-a"}, {"ss", "-u", "-a", "-n"}} {
		output, err = exec.Command(cmd[0], cmd[1:]...).CombinedOutput()
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read UDP sockets (install net-tools or iproute2): %w", err)
	}
	seen := map[string]bool{}
	candidates := make([]udpSearchCandidate, 0)
	for _, line := range strings.Split(string(output), "\n") {
		if !strings.Contains(strings.ToLower(line), "udp") {
			continue
		}
		matches := multicastEndpointRE.FindAllStringSubmatch(line, -1)
		for _, m := range matches {
			ip := net.ParseIP(m[1])
			port, _ := strconv.Atoi(m[2])
			if ip == nil || ip.To4() == nil || !ip.IsMulticast() || port <= 0 || port > 65535 {
				continue
			}
			key := fmt.Sprintf("%s:%d", ip.String(), port)
			if seen[key] {
				continue
			}
			seen[key] = true
			candidates = append(candidates, udpSearchCandidate{IP: ip.String(), Port: port})
			if len(candidates) > udpSearchMaxCandidates {
				return nil, fmt.Errorf("more than %d multicast endpoints; refusing unbounded scan", udpSearchMaxCandidates)
			}
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].IP == candidates[j].IP {
			return candidates[i].Port < candidates[j].Port
		}
		return candidates[i].IP < candidates[j].IP
	})
	return candidates, nil
}

// canonicalUDP normalizes both legacy IP-only values and udp://IP:port.
// TVAPLAY historically stored multicast IPs without an explicit port.
func canonicalUDP(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimPrefix(s, "udp://")
	s = strings.TrimPrefix(s, "@")
	s = strings.SplitN(s, "?", 2)[0]
	host, port, err := net.SplitHostPort(s)
	if err == nil {
		ip := net.ParseIP(host)
		if ip != nil && ip.To4() != nil {
			if port == "1234" {
				return ip.String()
			}
			return ip.String() + ":" + port
		}
	}
	if ip := net.ParseIP(s); ip != nil && ip.To4() != nil {
		return ip.String()
	}
	return s
}

// openGroupUDP follows chandetector/udp_linux.go: bind to the multicast
// destination address and join the group using the kernel-selected interface.
// One socket and one deadline are used per candidate.
func openGroupUDP(group net.IP, port int) (*net.UDPConn, error) {
	ip := group.To4()
	if ip == nil || !group.IsMulticast() {
		return nil, fmt.Errorf("invalid multicast group: %v", group)
	}
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_DGRAM, syscall.IPPROTO_UDP)
	if err != nil {
		return nil, err
	}
	// Ownership transfers to os.File only after successful socket setup.
	cleanup := true
	defer func() {
		if cleanup {
			_ = syscall.Close(fd)
		}
	}()

	if err := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
		return nil, err
	}
	addr := syscall.SockaddrInet4{Port: port}
	copy(addr.Addr[:], ip)
	if err := syscall.Bind(fd, &addr); err != nil {
		return nil, err
	}

	mreq := &syscall.IPMreqn{}
	copy(mreq.Multiaddr[:], ip)
	if err := syscall.SetsockoptIPMreqn(fd, syscall.IPPROTO_IP, syscall.IP_MULTICAST_IF, mreq); err != nil {
		return nil, err
	}
	if err := syscall.SetsockoptIPMreqn(fd, syscall.IPPROTO_IP, syscall.IP_ADD_MEMBERSHIP, mreq); err != nil {
		return nil, err
	}

	f := os.NewFile(uintptr(fd), "udp-multicast")
	cleanup = false
	conn, err := net.FilePacketConn(f)
	_ = f.Close()
	if err != nil {
		return nil, err
	}
	udpConn, ok := conn.(*net.UDPConn)
	if !ok {
		_ = conn.Close()
		return nil, fmt.Errorf("unexpected connection type %T", conn)
	}
	return udpConn, nil
}

func probeDVBService(c udpSearchCandidate) (udpSearchFound, error) {
	conn, err := openGroupUDP(net.ParseIP(c.IP), c.Port)
	if err != nil {
		return udpSearchFound{}, err
	}
	defer conn.Close()
	_ = conn.SetReadBuffer(512 * 1024)
	if err := conn.SetReadDeadline(time.Now().Add(udpSearchTimeout)); err != nil {
		return udpSearchFound{}, err
	}
	return readSDT(conn, c)
}

// mpegCRC32 checks an MPEG-2 PSI/SI section, including its CRC trailer.
func mpegCRC32(data []byte) uint32 {
	crc := uint32(0xffffffff)
	for _, b := range data {
		crc ^= uint32(b) << 24
		for i := 0; i < 8; i++ {
			if crc&0x80000000 != 0 {
				crc = crc<<1 ^ 0x04c11db7
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

func readSDT(conn *net.UDPConn, c udpSearchCandidate) (udpSearchFound, error) {
	buf := make([]byte, 65536)
	var section []byte
	var lastCC = -1
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return udpSearchFound{}, err
		}
		payload := buf[:n]
		for offset := 0; offset+188 <= len(payload); {
			if payload[offset] != 0x47 {
				offset++
				continue
			}
			p := payload[offset : offset+188]
			offset += 188
			// Discard transport errors and non-SDT packets.
			if p[1]&0x80 != 0 || (int(p[1]&0x1f)<<8|int(p[2])) != 0x11 {
				continue
			}
			if p[3]&0x10 == 0 {
				continue
			}
			cc := int(p[3] & 0x0f)
			if lastCC >= 0 && cc != ((lastCC+1)&0x0f) {
				section = nil
			}
			lastCC = cc
			start := 4
			if p[3]&0x20 != 0 {
				if start >= len(p) {
					section = nil
					continue
				}
				start += 1 + int(p[4])
			}
			if start >= len(p) {
				section = nil
				continue
			}
			if p[1]&0x40 != 0 {
				pointer := int(p[start])
				start++
				if start+pointer > len(p) {
					section = nil
					continue
				}
				// Start at the new section boundary, even if a previous section was incomplete.
				start += pointer
				section = nil
			} else if section == nil {
				continue
			}
			if start >= len(p) {
				continue
			}
			section = append(section, p[start:]...)
			if len(section) < 3 {
				continue
			}
			length := 3 + (int(section[1]&0x0f) << 8) + int(section[2])
			if length < 15 || length > 4096 {
				section = nil
				continue
			}
			if len(section) < length {
				continue
			}
			complete := section[:length]
			// Only CRC-valid SDT actual (table 0x42) is accepted.
			if complete[0] == 0x42 && mpegCRC32(complete) == 0 {
				if name, provider, sid, ok := parseDVBSDT(complete); ok {
					return udpSearchFound{
						UDP:  fmt.Sprintf("udp://%s:%d", c.IP, c.Port),
						Name: name, Provider: provider, ServiceID: sid,
					}, nil
				}
			}
			section = nil
		}
	}
}

// SDT table_id 0x42: service descriptors (tag 0x48) carry provider and name.
func parseDVBSDT(s []byte) (name, provider string, serviceID uint16, ok bool) {
	if len(s) < 15 || s[0] != 0x42 {
		return
	}
	end := len(s) - 4 // 4-byte CRC
	for pos := 11; pos+5 <= end; {
		sid := uint16(s[pos])<<8 | uint16(s[pos+1])
		descriptorsLen := int(s[pos+3]&0x0f)<<8 | int(s[pos+4])
		pos += 5
		if pos+descriptorsLen > end {
			return "", "", 0, false
		}
		limit := pos + descriptorsLen
		for pos+2 <= limit {
			tag := s[pos]
			size := int(s[pos+1])
			pos += 2
			if pos+size > limit {
				return "", "", 0, false
			}
			d := s[pos : pos+size]
			if tag == 0x48 && len(d) >= 3 {
				providerLen := int(d[1])
				if 2+providerLen >= len(d) {
					return "", "", 0, false
				}
				nameLen := int(d[2+providerLen])
				start := 3 + providerLen
				if start+nameLen > len(d) {
					return "", "", 0, false
				}
				provider = decodeDVBText(d[2 : 2+providerLen])
				name = decodeDVBText(d[start : start+nameLen])
				if name != "" {
					return name, provider, sid, true
				}
			}
			pos += size
		}
		pos = limit
	}
	return
}
func decodeDVBText(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	// ETSI EN 300 468: 0x01 explicitly selects ISO-8859-5 (Cyrillic).
	if data[0] == 0x01 {
		data = data[1:]
		decoded, err := charmap.ISO8859_5.NewDecoder().Bytes(data)
		if err == nil {
			return strings.TrimSpace(string(decoded))
		}
	}
	// UTF-8 selector 0x15; otherwise preserve UTF-8 or try ISO-8859-5.
	if data[0] == 0x15 {
		data = data[1:]
	}
	if utf8.Valid(data) {
		return strings.TrimSpace(string(data))
	}
	decoded, err := charmap.ISO8859_5.NewDecoder().Bytes(data)
	if err == nil {
		return strings.TrimSpace(string(decoded))
	}
	return ""
}

var udpSearchInsertMu sync.Mutex

func insertDetectedChannels(found []udpSearchFound) error {
	udpSearchInsertMu.Lock()
	defer udpSearchInsertMu.Unlock()
	for _, item := range found {
		added := false
		err := db.Transaction(func(tx *gorm.DB) error {
			var current []string
			if err := tx.Model(&models.Channel{}).Pluck("udp", &current).Error; err != nil {
				return err
			}
			for _, value := range current {
				if canonicalUDP(value) == canonicalUDP(item.UDP) {
					return nil
				}
			}
			var maximum uint16
			if err := tx.Model(&models.Channel{}).Select("COALESCE(MAX(position), 0)").Scan(&maximum).Error; err != nil {
				return err
			}
			if maximum == ^uint16(0) {
				return fmt.Errorf("channel position limit reached")
			}
			ch := models.Channel{
				Name: item.Name, UDP: item.UDP, Position: maximum + 1,
				Enable: 0, Record: 0, Transcode: 0, EPGID: "", StorageID: nil,
			}
			if err := tx.Create(&ch).Error; err != nil {
				return err
			}
			// The Channel model may specify gorm:default:1. Force zero explicitly.
			result := tx.Model(&models.Channel{}).Where("id = ?", ch.ID).
				UpdateColumns(map[string]interface{}{"enable": 0, "record": 0, "transcode": 0})
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return fmt.Errorf("failed to disable new channel id=%v", ch.ID)
			}
			added = true
			return nil
		})
		if err != nil {
			return err
		}
		if added {
			updateUDPSearch(func(s *udpSearchState) {
				s.Added++
				s.Channels = append(s.Channels, item)
			})
		} else {
			updateUDPSearch(func(s *udpSearchState) { s.Skipped++ })
		}
	}
	return nil
}
