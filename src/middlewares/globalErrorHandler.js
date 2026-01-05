export default (err, _, res, __) => {
    res.status(err.statusCode).json(err)
}
