FILE=stash

if [ -f $FILE.key ]; then
  echo "ERROR: $FILE.key already exists"
  exit 1
fi

openssl genrsa -out ${FILE}.key 1024
openssl req -new -key ${FILE}.key -out ${FILE}.csr
openssl x509 -req -in ${FILE}.csr -signkey ${FILE}.key -out ${FILE}.crt
cat ${FILE}.key > ${FILE}.pem
cat ${FILE}.crt >> ${FILE}.pem

# Setup Application Links in Stash Admin
# Using the above generated keys, create the public key and use that when creating the application link in Stash.
openssl rsa -in ${FILE}.pem -pubout > ${FILE}.pub

