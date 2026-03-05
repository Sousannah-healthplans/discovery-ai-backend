import { Router } from 'express'
import Claim from '../models/Claim.js'

const router = Router()

router.get('/', async (req, res) => {
  const list = await Claim.find({ userId: req.userId }).sort({ createdAt: -1 })
  res.json(list)
})

router.post('/', async (req, res) => {
  try {
    const body = req.body || {}
    const doc = await Claim.create({
      userId: req.userId,
      claimId: body.claimId || `CLM-${Date.now()}`,
      status: body.status || 'Open',
      amount: Number(body.amount) || 0,
      description: body.description || '',
      notes: body.notes || '',
      attachments: body.attachments || []
    })
    req.app.get('io').to(`user:${req.userId}`).emit('claim:created', doc)
    res.json(doc)
  } catch (e) {
    res.status(400).json({ error: 'Invalid data' })
  }
})

router.put('/:id', async (req, res) => {
  const id = req.params.id
  const body = req.body || {}
  const updated = await Claim.findOneAndUpdate({ _id: id, userId: req.userId }, body, { new: true })
  if (!updated) return res.status(404).json({ error: 'Not found' })
  req.app.get('io').to(`user:${req.userId}`).emit('claim:updated', updated)
  res.json(updated)
})

router.delete('/:id', async (req, res) => {
  const id = req.params.id
  const deleted = await Claim.findOneAndDelete({ _id: id, userId: req.userId })
  if (!deleted) return res.status(404).json({ error: 'Not found' })
  req.app.get('io').to(`user:${req.userId}`).emit('claim:deleted', { _id: id })
  res.json({ success: true })
})

export default router


