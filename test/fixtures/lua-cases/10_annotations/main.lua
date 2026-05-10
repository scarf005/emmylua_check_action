---@param name string
---@return string
local function label(name)
  return "item:" .. name
end

local value = label("book")
print(value)
