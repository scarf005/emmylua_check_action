local text = "one,two,three"
local count = 0

for _ in string.gmatch(text, "[^,]+") do
  count = count + 1
end

print(count)
