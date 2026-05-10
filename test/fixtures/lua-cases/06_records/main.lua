local function new_vector(x, y)
  return { x = x, y = y }
end

local function length_squared(vector)
  return vector.x * vector.x + vector.y * vector.y
end

local point = new_vector(3, 4)
print(length_squared(point))
