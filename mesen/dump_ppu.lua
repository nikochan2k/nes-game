-- 診断用: 読み込んだ瞬間の PPU の状態 (パレット RAM・4 枚のネームテーブルと属性テーブル) を
-- 127.0.0.1:5560 に 1 行 1 ブロックのテキストで送る。bridge.lua とは別のスクリプトウィンドウで実行する。
-- 受け取り側: bun server/ppu_dump.ts  (data/ppu_dump.txt に保存して集計する)
local HOST, PORT = "127.0.0.1", 5560
local socket = require("socket.core")
local conn = assert(socket.tcp())
conn:settimeout(5)
assert(conn:connect(HOST, PORT))

local function ppu(addr) return emu.read(addr, emu.memType.nesPpuMemory) end
local function line(name, from, count)
  local t = {}
  for i = 0, count - 1 do t[#t + 1] = string.format("%02X", ppu(from + i)) end
  conn:send(name .. " " .. table.concat(t, " ") .. "\n")
end

line("PALETTE", 0x3F00, 32)
for nt = 0, 3 do
  line("NT" .. nt, 0x2000 + nt * 0x400, 960)       -- 32 x 30 タイル
  line("ATTR" .. nt, 0x2000 + nt * 0x400 + 960, 64)
end
conn:send("END\n")
conn:close()
emu.log("dump_ppu: sent")
