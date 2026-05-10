local function counter()
  local value = 0

  return function()
    value = value + 1
    return value
  end
end

local next_value = counter()
print(next_value(), next_value())
