import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'

const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me'
const JWT_EXPIRES = '7d'

export function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES })
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET)
}

export async function hashPassword(password) {
  const salt = await bcrypt.genSalt(10)
  return bcrypt.hash(password, salt)
}

export async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash)
}

export function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Unauthorized' })
  try {
    const payload = verifyToken(token)
    req.userId = payload.sub
    next()
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}


