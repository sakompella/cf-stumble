package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"testing"
	"time"
)

const chainHost = "hp-server.dog-minnow.ts.net"

var frozenNow = time.Date(2026, time.November, 1, 0, 0, 0, 0, time.UTC)

func chain(t *testing.T) []*x509.Certificate {
	t.Helper()

	data, err := os.ReadFile(os.Getenv("TAILNET_ROOTS_CHAIN"))
	if err != nil {
		t.Fatal(err)
	}

	var certs []*x509.Certificate

	for block, rest := pem.Decode(data); block != nil; block, rest = pem.Decode(rest) {
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			t.Fatal(err)
		}

		certs = append(certs, cert)
	}

	if len(certs) != 4 {
		t.Fatalf("expected 4 certificates, got %d", len(certs))
	}

	return certs
}

func verify(leaf *x509.Certificate, intermediates []*x509.Certificate, host string) error {
	pool := x509.NewCertPool()

	for _, cert := range intermediates {
		pool.AddCert(cert)
	}

	_, err := leaf.Verify(x509.VerifyOptions{
		DNSName:       host,
		Intermediates: pool,
		CurrentTime:   frozenNow,
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})

	return err
}

func TestPublicChainVerifiesWithoutSystemRoots(t *testing.T) {
	certs := chain(t)

	if err := verify(certs[0], certs[1:], chainHost); err != nil {
		t.Fatal(err)
	}
}

func TestPublicChainRefusesAnotherHostname(t *testing.T) {
	certs := chain(t)

	var wrongHost x509.HostnameError

	if err := verify(certs[0], certs[1:], "attacker.dog-minnow.ts.net"); !errors.As(err, &wrongHost) {
		t.Fatalf("expected a hostname error, got %v", err)
	}
}

func TestSelfSignedCertificateIsRefused(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: chainHost},
		DNSNames:     []string{chainHost},
		NotBefore:    frozenNow.Add(-time.Hour),
		NotAfter:     frozenNow.Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}

	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}

	var unknown x509.UnknownAuthorityError

	if err := verify(leaf, nil, chainHost); !errors.As(err, &unknown) {
		t.Fatalf("expected an unknown authority error, got %v", err)
	}
}
