local items = { "red", "green", "blue" }
local upper = {}

for index, value in ipairs(items) do
  upper[index] = string.upper(value)
end

print(table.concat(upper, ","))
