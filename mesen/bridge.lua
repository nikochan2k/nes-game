-- Mesen 用ブリッジ: コントローラポート 2 のシリアル (src/link.c) を TCP の地図サーバーにつなぐ。
-- 実機では Raspberry Pi Pico がこの役を担う。
--
-- 事前に Mesen のスクリプトウィンドウの設定で "Allow network access" を有効にしておくこと。
-- サーバー: python3 server/mapserver.py  (既定 127.0.0.1:5555)

local HOST, PORT = "127.0.0.1", 5555
local SYNC = 0xA5
local REQ_LEN = 9

local socket = require("socket.core")
local conn = assert(socket.tcp())
conn:settimeout(5)
assert(conn:connect(HOST, PORT))
conn:setoption("tcp-nodelay", true)

local latch = 0           -- $4016 bit0 の現在値
local state = "idle"      -- idle: 同期待ち / req: 要求受信中 / resp: 応答送信中
local window = 0          -- 直近 8 ビット (同期バイト検出用)
local req, cur, nbits
local resp, rbit, total

local function finish_request()
  conn:send(string.char(table.unpack(req)))
  local len = req[REQ_LEN] & 0x3F
  local data, err = conn:receive(len)
  if not data then
    emu.log("bridge: server error " .. tostring(err))
    data = string.rep("\3", len)
  end
  resp, rbit, total = data, -1, len * 8
  state = "resp"
end

emu.addMemoryCallback(function(_, value)
  latch = value & 1
end, emu.callbackType.write, 0x4016)

emu.addMemoryCallback(function(_, value)
  local out = 0
  if state == "idle" then
    window = ((window << 1) | latch) & 0xFF
    if window == SYNC then
      state, req, cur, nbits = "req", {}, 0, 0
    end
  elseif state == "req" then
    cur = (cur << 1) | latch
    nbits = nbits + 1
    if nbits % 8 == 0 then
      req[#req + 1] = cur
      cur = 0
      if #req == REQ_LEN then
        finish_request()
      end
    end
  else                                  -- resp: 開始ビット 1、続けてデータ
    if rbit < 0 then
      out, rbit = 1, 0
    else
      local byte = resp:byte(rbit // 8 + 1)
      out = (byte >> (7 - rbit % 8)) & 1
      rbit = rbit + 1
      if rbit == total then
        state, window = "idle", 0
      end
    end
  end
  return (value & 0xFE) | out
end, emu.callbackType.read, 0x4017)

emu.log("bridge: connected to " .. HOST .. ":" .. PORT)
